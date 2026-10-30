import "server-only";
import { randomUUID } from "node:crypto";
import { getSiteContent } from "@/lib/content/get";
import { getSettings } from "@/lib/data/settings";
import type { MEDIA_FILE_KINDS, MEDIA_PURPOSES, UPLOAD_EVENT_KINDS } from "@/lib/db/schema";
import { getBoss } from "@/lib/jobs/boss";
import { MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { originalKey } from "@/lib/storage/keys";
import { writeManifest } from "@/lib/storage/manifest";
import {
  abortMultipart,
  completeMultipart,
  headOriginal,
  listUploadedParts,
  presignParts,
  startMultipart,
  type PartUrl,
  type UploadedPart,
} from "@/lib/storage/objects";
import { assignCelebration } from "./celebration";
import { PART_SIZE_BYTES, partCount, partSizeOf } from "./limits";
import {
  attachMultipartUpload,
  deleteUnfinishedUpload,
  findUpload,
  insertUpload,
  markUploaded,
  recordUploadEvents,
  type UploadRow,
} from "./rows";

/*
 * The upload API's work, apart from HTTP: starting or resuming an upload, presigning its parts,
 * verifying and completing it, and cancelling it. Phones send the bytes straight to R2; this never
 * touches them. The routes under /api/uploads call it, and Task 19's site-photo route can too.
 *
 * Each step is a single statement or an R2 call, never an R2 call inside a transaction. A step that
 * fails part-way leaves a row the next re-pick of the file can carry on from (see resumeUpload) or
 * that the worker's sweeper picks up (an `uploaded` row whose job never got queued).
 */

type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];
type UploadEventKind = (typeof UPLOAD_EVENT_KINDS)[number];

/** How long after the couple close uploads an upload started before the close may still finish. */
export const UPLOADS_GRACE_MILLISECONDS = 24 * 60 * 60 * 1000;

export const UPLOADS_CLOSED_MESSAGE =
  "Uploads to the album have closed. Thank you for every photo and video you shared!";

/** The couple's uploads switch: open, or closed since `closedAt`. */
export type UploadsSwitch = { open: boolean; closedAt: Date | null };

/** For uploads the switch doesn't govern (wishes). */
export const UPLOADS_ALWAYS_OPEN: UploadsSwitch = { open: true, closedAt: null };

/** The uploads switch, in one query. Fails closed: nothing saved, or anything but true, is closed. */
export async function readUploadsSwitch(): Promise<UploadsSwitch> {
  const saved = await getSettings({ uploads_open: false, uploads_closed_at: null });
  const closedAt = typeof saved.uploads_closed_at === "string" ? new Date(saved.uploads_closed_at) : null;
  return {
    open: saved.uploads_open === true,
    closedAt: closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : null,
  };
}

/** Whether a new upload for this purpose may start: wishes always, album uploads while open. */
export function mayStartUpload(purpose: MediaPurpose, uploads: UploadsSwitch): boolean {
  return purpose !== "album" || uploads.open;
}

/**
 * Whether an unfinished upload may go on (resume, presign, complete): wishes always; album uploads
 * while open, or, once closed, one started before the close and only for 24 hours after it.
 */
export function mayContinueUpload(
  upload: Pick<UploadRow, "purpose" | "startedAt">,
  uploads: UploadsSwitch,
  now: Date = new Date(),
): boolean {
  if (upload.purpose !== "album" || uploads.open) return true;
  if (!uploads.closedAt) return false;
  const closedAt = uploads.closedAt.getTime();
  return upload.startedAt.getTime() < closedAt && now.getTime() < closedAt + UPLOADS_GRACE_MILLISECONDS;
}

/** Whether anyone may still see the item: not hidden, removed or deleted (isVisible, from a row in hand). */
export function isVisibleUpload(upload: Pick<UploadRow, "hiddenAt" | "deletedAt" | "removedByUploader">): boolean {
  return upload.hiddenAt === null && upload.deletedAt === null && !upload.removedByUploader;
}

/** What the phone needs to send an upload's parts, the same for a new upload and a resumed one. */
export type UploadSession = {
  mediaId: string;
  uploadId: string;
  key: string;
  partSize: number;
  partCount: number;
  /** The parts R2 already holds, which the phone skips. */
  uploadedParts: UploadedPart[];
};

/** Runs a task after the response is sent: the routes pass Next's after(). */
export type Defer = (task: () => Promise<void>) => void;

export type UploadOptions = {
  /** Ends the R2 calls early (the request's signal, or a budget for several calls). */
  signal?: AbortSignal;
  defer: Defer;
};

function toSession(upload: UploadRow, uploadId: string, uploadedParts: UploadedPart[]): UploadSession {
  return {
    mediaId: upload.id,
    uploadId,
    key: upload.originalKey,
    partSize: PART_SIZE_BYTES,
    partCount: partCount(upload.sizeBytes),
    uploadedParts,
  };
}

/**
 * Every part of an upload R2 has already joined into its original. The ETags are gone with the
 * multipart upload, so they are empty: the phone, finding nothing left to send, completes, and
 * that answers at once.
 */
function everyPart(sizeBytes: number): UploadedPart[] {
  return Array.from({ length: partCount(sizeBytes) }, (_, index) => ({
    partNumber: index + 1,
    etag: "",
    size: partSizeOf(sizeBytes, index + 1),
  }));
}

function bytesHeld(parts: UploadedPart[]): number {
  return parts.reduce((total, part) => total + part.size, 0);
}

/**
 * Aborts an unfinished upload and deletes its row, unless it turns out to have finished: no
 * original may ever exist without its row (Ruling Y), or a rebuild from R2 would bring back a file
 * the guest cancelled, and nothing could delete it. Once the abort returns, no complete of it can
 * succeed, so the original is there now or never: if it is (a complete R2 joined first), the row
 * stays, for that complete to mark; if not, the row goes. The original is checked whatever the
 * abort answered, since a store may accept an abort of an upload it has already completed (MinIO
 * does). True when the row was deleted.
 */
async function abortAndDelete(upload: UploadRow, uploadId: string, signal: AbortSignal | undefined): Promise<boolean> {
  await abortMultipart(upload.originalKey, uploadId, { signal });
  if (await headOriginal(upload.originalKey, { signal })) return false;
  return deleteUnfinishedUpload(upload.id);
}

/**
 * Drops an upload whose parts hold more than it declared: its multipart upload (and the bytes
 * with it) and its row. The part URLs bind each part's size, so this takes R2 letting a PUT of
 * another length through; it stops a client storing past the limits until the 7-day rule.
 */
async function discardOverfilled(upload: UploadRow, uploadId: string, options: UploadOptions): Promise<void> {
  console.error(`[uploads] ${upload.id} holds more than it declared; aborting it`);
  await abortAndDelete(upload, uploadId, options.signal);
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** The queue that processes an uploaded item: a wish's recording, a video's poster or a photo. */
export function processingQueue(upload: Pick<UploadRow, "purpose" | "kind">): MediaQueueName {
  if (upload.purpose === "wish") return MEDIA_QUEUES.wish;
  return upload.kind === "video" ? MEDIA_QUEUES.poster : MEDIA_QUEUES.photo;
}

/** Records an event the server saw itself. Never throws: the status page can miss one. */
async function recordEvent(upload: UploadRow, kind: UploadEventKind): Promise<void> {
  try {
    await recordUploadEvents([{ guestId: upload.guestId, mediaId: upload.id, kind }]);
  } catch (error) {
    console.error(`[uploads] could not record a ${kind} event for ${upload.id}:`, describeError(error));
  }
}

/**
 * Queues the item's processing and records that it completed, after the response. Never throws:
 * an item whose job doesn't get queued (the queue still starting, or down) stays `uploaded`, and
 * the worker's sweeper queues it.
 */
async function announceUploaded(upload: UploadRow): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send(processingQueue(upload), { mediaId: upload.id });
  } catch (error) {
    console.error(`[uploads] could not queue ${upload.id} for processing; the sweeper will:`, describeError(error));
  }
  await recordEvent(upload, "completed");
}

/**
 * Marks a verified upload `uploaded`; the call that changes it queues the job, after the response.
 * A row left as it was is `uploaded` already (another complete marked it first), or `missing`: its
 * row is gone, though R2 has joined its original. A cancel never deletes the row of an upload R2
 * has joined (abortAndDelete), so this is a defence; the warning keeps the orphan's key on record.
 */
async function finishUpload(upload: UploadRow, options: UploadOptions): Promise<"uploaded" | "missing"> {
  if (await markUploaded(upload.id)) {
    options.defer(() => announceUploaded(upload));
    return "uploaded";
  }
  if (await findUpload(upload.id)) return "uploaded";
  console.warn(`[uploads] ${upload.originalKey} was joined after its row was deleted: an original with no row`);
  return "missing";
}

/**
 * After NoSuchUpload: whether the upload had in fact completed (an earlier complete reached R2 and
 * its answer was lost), in which case it is finished now. `no-original` when the original isn't
 * there: the upload was aborted (cancelled, or expired under R2's 7-day rule).
 */
async function finishIfOriginalExists(
  upload: UploadRow,
  options: UploadOptions,
): Promise<"uploaded" | "missing" | "no-original"> {
  const original = await headOriginal(upload.originalKey, { signal: options.signal });
  if (!original || original.size !== upload.sizeBytes) return "no-original";
  return finishUpload(upload, options);
}

/**
 * The parts R2 holds for an unfinished upload. An upload R2 had already completed is finished
 * here and lists every part. Null when the upload is gone and no original was made, or when its
 * parts hold more than it declared (then it is discarded).
 */
async function partsSoFar(upload: UploadRow, uploadId: string, options: UploadOptions): Promise<UploadedPart[] | null> {
  let parts: UploadedPart[];
  try {
    parts = await listUploadedParts(upload.originalKey, uploadId, { signal: options.signal });
  } catch (error) {
    if (errorName(error) !== "NoSuchUpload") throw error;
    return (await finishIfOriginalExists(upload, options)) === "uploaded" ? everyPart(upload.sizeBytes) : null;
  }
  if (bytesHeld(parts) <= upload.sizeBytes) return parts;
  await discardOverfilled(upload, uploadId, options);
  return null;
}

/**
 * Starts the original's multipart upload, with its write-once metadata, and writes its manifest;
 * then records the upload id on the row. If another request recorded one first (two re-picks at
 * once), ours is dropped and theirs used.
 */
async function beginMultipart(upload: UploadRow, signal: AbortSignal | undefined): Promise<string> {
  const [uploadId] = await Promise.all([
    startMultipart(
      upload.originalKey,
      upload.contentType,
      {
        guestId: upload.guestId,
        uploaderName: upload.uploaderName ?? "",
        originalFilename: upload.originalFilename,
        startedAt: upload.startedAt,
      },
      { signal },
    ),
    writeManifest(
      upload.id,
      {
        celebration: upload.celebration,
        celebrationSetByAdmin: false,
        hiddenAt: null,
        hiddenBy: null,
        removedByUploader: false,
        deletedAt: null,
      },
      { signal },
    ),
  ]);
  const kept = await attachMultipartUpload(upload.id, uploadId);
  if (kept === uploadId) return uploadId;
  await abortMultipart(upload.originalKey, uploadId, { signal }).catch((error) =>
    console.error("[uploads] could not abort a duplicate multipart upload:", describeError(error)),
  );
  if (kept === null) throw new Error("The upload was cancelled or completed while it started");
  return kept;
}

export type NewUploadRequest = {
  purpose: MediaPurpose;
  kind: MediaFileKind;
  /** The uploading guest; null for a site photo. */
  guestId: string | null;
  /** The name shown with the item; null takes the guest's own. */
  uploaderName: string | null;
  originalFilename: string;
  sizeBytes: number;
  contentType: string;
  /** The extension of the original's key (checkUpload). */
  extension: string;
  fingerprint: string | null;
  /** When the phone says the file was taken; the worker refines it from the file itself. */
  capturedAt: Date | null;
};

/**
 * Starts a new upload: its row (grouped by when it was taken, else when it started), then its
 * multipart upload and manifest. If R2 fails, the row is removed so nothing is left half-made; if
 * that fails too, the row (with no upload id) is carried on by the next re-pick of the file.
 */
export async function createUpload(request: NewUploadRequest, options: UploadOptions): Promise<UploadSession> {
  const mediaId = randomUUID();
  const startedAt = new Date();
  const { celebrations } = await getSiteContent();
  const upload = await insertUpload({
    id: mediaId,
    purpose: request.purpose,
    kind: request.kind,
    guestId: request.guestId,
    uploaderName: request.uploaderName,
    celebration: assignCelebration(request.capturedAt, startedAt, celebrations),
    originalKey: originalKey(mediaId, request.extension),
    originalFilename: request.originalFilename,
    sizeBytes: request.sizeBytes,
    contentType: request.contentType,
    fileFingerprint: request.fingerprint,
    startedAt,
    capturedAt: request.capturedAt,
  });
  try {
    return toSession(upload, await beginMultipart(upload, options.signal), []);
  } catch (error) {
    await deleteUnfinishedUpload(upload.id).catch((cleanupError) =>
      console.error("[uploads] could not remove the row of a start that failed:", describeError(cleanupError)),
    );
    throw error;
  }
}

/**
 * Carries on a guest's unfinished upload of the same file (found by fingerprint): its session,
 * with the parts R2 already holds. A row whose multipart upload never began gets one now. Null
 * when the upload has expired with nothing made of it: the stale row is removed, and the caller
 * starts afresh.
 */
export async function resumeUpload(upload: UploadRow, options: UploadOptions): Promise<UploadSession | null> {
  let session: UploadSession;
  if (!upload.multipartUploadId) {
    session = toSession(upload, await beginMultipart(upload, options.signal), []);
  } else {
    const parts = await partsSoFar(upload, upload.multipartUploadId, options);
    if (!parts) {
      // Nothing to carry on. The row goes only if no original was made (Ruling Y).
      if (!(await headOriginal(upload.originalKey, { signal: options.signal }))) await deleteUnfinishedUpload(upload.id);
      return null;
    }
    session = toSession(upload, upload.multipartUploadId, parts);
  }
  options.defer(() => recordEvent(upload, "resumed"));
  return session;
}

/**
 * The parts R2 holds for the upload, for a phone carrying it on: every part once it is uploaded,
 * none before its multipart upload began, and null when the upload has expired.
 */
export async function listUploadParts(upload: UploadRow, options: UploadOptions): Promise<UploadedPart[] | null> {
  if (upload.status !== "uploading") return everyPart(upload.sizeBytes);
  if (!upload.multipartUploadId) return [];
  return partsSoFar(upload, upload.multipartUploadId, options);
}

/**
 * Presigned PUT URLs for these parts (at most 20), each valid for an hour and bound to the part's
 * size: 8 MiB, or the remainder for the last. Local: no network.
 */
export async function presignUploadParts(upload: UploadRow, partNumbers: number[]): Promise<PartUrl[] | null> {
  if (!upload.multipartUploadId) return null;
  return presignParts(
    upload.originalKey,
    upload.multipartUploadId,
    partNumbers.map((partNumber) => ({ partNumber, size: partSizeOf(upload.sizeBytes, partNumber) })),
  );
}

/**
 * What completing an upload came to:
 * - `uploaded`: verified and joined (or found already joined), the row marked and its job queued;
 * - `incomplete`: the parts R2 holds don't add up to the declared size, so nothing changed;
 * - `invalid-parts`: they add up, but R2 refused to join them (a part other than the last under 5 MiB);
 * - `overfilled`: they hold more than the declared size, so the upload was discarded;
 * - `missing`: the guest cancelled it while R2 joined its parts, so its row is gone and nothing is queued;
 * - `expired`: the upload is gone and no original was made (aborted or expired).
 */
export type CompleteOutcome = "uploaded" | "incomplete" | "invalid-parts" | "overfilled" | "missing" | "expired";

/** What completing comes to once R2 says NoSuchUpload: done if the original is there. */
async function completedAlready(upload: UploadRow, options: UploadOptions): Promise<CompleteOutcome> {
  const finished = await finishIfOriginalExists(upload, options);
  return finished === "no-original" ? "expired" : finished;
}

// R2's refusals of a join whose parts are the wrong shape, rather than a passing fault.
const BAD_PARTS = new Set(["EntityTooSmall", "InvalidPart", "InvalidPartOrder"]);

/**
 * Completes an unfinished upload. Its parts are listed first and must add up to the declared size
 * (the phone shows "Added" only after this); R2 then joins them, from its own list. A NoSuchUpload
 * at either step counts as done if the original is there (HeadObject only then), so a repeated or
 * concurrent complete succeeds and queues one job.
 */
export async function completeUpload(upload: UploadRow, options: UploadOptions): Promise<CompleteOutcome> {
  const uploadId = upload.multipartUploadId;
  if (!uploadId) return "incomplete";
  let parts: UploadedPart[];
  try {
    parts = await listUploadedParts(upload.originalKey, uploadId, { signal: options.signal });
  } catch (error) {
    if (errorName(error) !== "NoSuchUpload") throw error;
    return completedAlready(upload, options);
  }
  const receivedBytes = bytesHeld(parts);
  if (receivedBytes > upload.sizeBytes) {
    await discardOverfilled(upload, uploadId, options);
    return "overfilled";
  }
  if (receivedBytes < upload.sizeBytes) return "incomplete";
  try {
    await completeMultipart(upload.originalKey, uploadId, parts, { signal: options.signal });
  } catch (error) {
    const name = errorName(error);
    if (name === "NoSuchUpload") return completedAlready(upload, options);
    if (name && BAD_PARTS.has(name)) return "invalid-parts";
    throw error;
  }
  return finishUpload(upload, options);
}

/**
 * Cancels an unfinished upload at the guest's request: aborts its multipart upload, then deletes
 * its row (its events stay). False when it finished meanwhile (a complete R2 joined first), which
 * leaves it as it is, to be removed like any finished upload. Nothing else aborts uploads: R2's
 * 7-day rule clears the abandoned ones.
 */
export async function cancelUpload(upload: UploadRow, options: { signal?: AbortSignal }): Promise<boolean> {
  if (!upload.multipartUploadId) return deleteUnfinishedUpload(upload.id);
  return abortAndDelete(upload, upload.multipartUploadId, options.signal);
}
