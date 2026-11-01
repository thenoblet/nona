import "server-only";
import type { UPLOAD_EVENT_KINDS } from "@/lib/db/schema";
import { getBoss } from "@/lib/jobs/boss";
import { MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { deleteManifest } from "@/lib/storage/manifest";
import {
  abortMultipart,
  completeMultipart,
  headOriginal,
  listUploadedParts,
  type UploadedPart,
} from "@/lib/storage/objects";
import { deleteUnfinishedUpload, findUpload, markUploaded, recordUploadEvents, type UploadRow } from "./rows";

/*
 * Completing an upload: verifying its parts, joining them, marking it `uploaded` and queuing its
 * processing. The upload API (uploads.ts) completes an upload when the phone asks; the media
 * worker's sweeper completes one whose phone dropped at the very end. The worker bundles this
 * file, so it reaches nothing from next/ (the worker's bundle build refuses it): uploads.ts, which
 * reads the site's content through Next's cache, re-exports what the routes use from here.
 */

type UploadEventKind = (typeof UPLOAD_EVENT_KINDS)[number];

/** Runs a task after the response is sent: the routes pass Next's after(). */
export type Defer = (task: () => Promise<void>) => void;

export type UploadOptions = {
  /** Ends the R2 calls early (the request's signal, or a budget for several calls). */
  signal?: AbortSignal;
  defer: Defer;
};

export function bytesHeld(parts: UploadedPart[]): number {
  return parts.reduce((total, part) => total + part.size, 0);
}

/**
 * Deletes an unfinished upload's row, then its manifest, so a rebuild from R2 finds nothing of it.
 * A manifest R2 won't delete is logged and left: it names no original, so a rebuild ignores it.
 * True when the row was deleted (false when it had finished meanwhile, or was gone).
 */
export async function deleteUnfinished(mediaId: string, signal: AbortSignal | undefined): Promise<boolean> {
  if (!(await deleteUnfinishedUpload(mediaId))) return false;
  try {
    await deleteManifest(mediaId, { signal });
  } catch (error) {
    console.error(`[uploads] ${mediaId}'s row is deleted, but its manifest wasn't:`, describeError(error));
  }
  return true;
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
export async function abortAndDelete(
  upload: UploadRow,
  uploadId: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  await abortMultipart(upload.originalKey, uploadId, { signal });
  if (await headOriginal(upload.originalKey, { signal })) return false;
  return deleteUnfinished(upload.id, signal);
}

/**
 * Drops an upload whose parts hold more than it declared: its multipart upload (and the bytes
 * with it) and its row. The part URLs bind each part's size, so this takes R2 letting a PUT of
 * another length through; it stops a client storing past the limits until the 7-day rule.
 */
export async function discardOverfilled(upload: UploadRow, uploadId: string, options: UploadOptions): Promise<void> {
  console.error(`[uploads] ${upload.id} holds more than it declared; aborting it`);
  await abortAndDelete(upload, uploadId, options.signal);
}

export function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * The queue that processes an uploaded item: a wish's recording, a video's poster or a photo. A
 * wish's recording is sent there only once a wish names it (Ruling CE): by addWish, the sweeper, or
 * an unhide.
 */
export function processingQueue(upload: Pick<UploadRow, "purpose" | "kind">): MediaQueueName {
  if (upload.purpose === "wish") return MEDIA_QUEUES.wish;
  return upload.kind === "video" ? MEDIA_QUEUES.poster : MEDIA_QUEUES.photo;
}

/** Records an event the server saw itself. Never throws: the status page can miss one. */
export async function recordEvent(upload: UploadRow, kind: UploadEventKind): Promise<void> {
  try {
    await recordUploadEvents([{ guestId: upload.guestId, mediaId: upload.id, kind }]);
  } catch (error) {
    console.error(`[uploads] could not record a ${kind} event for ${upload.id}:`, describeError(error));
  }
}

/**
 * Queues the item's processing and records that it completed, after the response. Never throws:
 * an item whose job doesn't get queued (the queue still starting, or down) stays `uploaded`, and
 * the worker's sweeper queues it. A wish's recording isn't queued here (Ruling CE): it is made only
 * once a wish names it (addWish sends its job), so a recording whose wish never comes (an orphan)
 * never has a public file; its original stays private.
 */
async function announceUploaded(upload: UploadRow): Promise<void> {
  if (upload.purpose !== "wish") {
    try {
      const boss = await getBoss();
      await boss.send(processingQueue(upload), { mediaId: upload.id });
    } catch (error) {
      console.error(`[uploads] could not queue ${upload.id} for processing; the sweeper will:`, describeError(error));
    }
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
export async function finishIfOriginalExists(
  upload: UploadRow,
  options: UploadOptions,
): Promise<"uploaded" | "missing" | "no-original"> {
  const original = await headOriginal(upload.originalKey, { signal: options.signal });
  if (!original || original.size !== upload.sizeBytes) return "no-original";
  return finishUpload(upload, options);
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
