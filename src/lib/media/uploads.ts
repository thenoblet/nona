import "server-only";
import { randomUUID } from "node:crypto";
import { getSiteContent } from "@/lib/content/get";
import type { MEDIA_FILE_KINDS, MEDIA_PURPOSES } from "@/lib/db/schema";
import { describeError } from "@/lib/log-error";
import { originalKey } from "@/lib/storage/keys";
import {
  abortMultipart,
  headOriginal,
  listUploadedParts,
  presignParts,
  startMultipart,
  type PartUrl,
  type UploadedPart,
} from "@/lib/storage/objects";
import { assignCelebration } from "./celebration";
import {
  abortAndDelete,
  bytesHeld,
  deleteUnfinished,
  discardOverfilled,
  errorName,
  finishIfOriginalExists,
  recordEvent,
  type UploadOptions,
} from "./completion";
import { PART_SIZE_BYTES, partCount, partSizeOf } from "./limits";
import { syncManifest } from "./manifest-sync";
import { attachMultipartUpload, insertUpload, type UploadRow } from "./rows";

// Completing an upload and the uploads switch live in completion.ts and uploads-switch.ts, which the
// media worker's sweeper bundles too.
export { completeUpload, processingQueue } from "./completion";
export type { CompleteOutcome, Defer, UploadOptions } from "./completion";
export {
  mayContinueUpload,
  mayStartUpload,
  readUploadsSwitch,
  UPLOADS_ALWAYS_OPEN,
  UPLOADS_GRACE_MILLISECONDS,
} from "./uploads-switch";
export type { UploadsSwitch } from "./uploads-switch";

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

export const UPLOADS_CLOSED_MESSAGE =
  "Uploads to the album have closed. Thank you for every photo and video you shared!";

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
 * Starts the original's multipart upload, with its write-once metadata, and writes its manifest
 * (through syncManifest, as every manifest write goes, from the facts the new row has); then records
 * the upload id on the row. If another request recorded one first (two re-picks at once), ours is
 * dropped and theirs used.
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
    syncManifest(upload.id, {
      known: {
        celebration: upload.celebration,
        celebrationSetByAdmin: false,
        hiddenAt: null,
        hiddenBy: null,
        removedByUploader: false,
        deletedAt: null,
      },
      signal,
    }),
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
    await deleteUnfinished(upload.id, options.signal).catch((cleanupError) =>
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
      if (!(await headOriginal(upload.originalKey, { signal: options.signal }))) await deleteUnfinished(upload.id, options.signal);
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
 * Cancels an unfinished upload at the guest's request: aborts its multipart upload, then deletes
 * its row and its manifest (its events stay). False when it finished meanwhile (a complete R2
 * joined first), which leaves it as it is, to be removed like any finished upload. Nothing else
 * aborts uploads: R2's 7-day rule clears the abandoned ones.
 */
export async function cancelUpload(upload: UploadRow, options: { signal?: AbortSignal }): Promise<boolean> {
  if (!upload.multipartUploadId) return deleteUnfinished(upload.id, options.signal);
  return abortAndDelete(upload, upload.multipartUploadId, options.signal);
}
