import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { describeError } from "@/lib/log-error";
import { isVisible } from "@/lib/media/rows";
import { writeManifest, type MediaManifest } from "@/lib/storage/manifest";
import { deletePublicObjects } from "@/lib/storage/objects";
import type { WorkQueueName } from "../queues";

/*
 * What every processing job (a photo's, a video's poster) does around its ready mark: names its
 * derived files by a content hash, takes them down again when the item was hidden while it worked,
 * and writes the item's manifest again once it is ready.
 */

/** Hex characters of the content hash kept in a key: 64 bits, beside the item's own id. */
const CONTENT_HASH_CHARACTERS = 16;
/** The manifest's write is tried this many times after the ready mark, a short and growing wait apart. */
const MANIFEST_ATTEMPTS = 3;
const MANIFEST_RETRY_MILLISECONDS = 250;

/**
 * The derived files' content hash: the original's ETag (its bytes never change) and the job's
 * settings, such as "photo-settings-1". A job raises its settings' version whenever what it makes
 * changes (a size, a quality), so the files made again get new keys, which no cache has seen.
 */
export function contentHashOf(etag: string, settings: string): string {
  return createHash("sha256").update(`${etag}\n${settings}`).digest("hex").slice(0, CONTENT_HASH_CHARACTERS);
}

/**
 * After a ready mark that changed nothing: an item hidden, deleted or gone while the job worked
 * must have no public files, so the ones it put up come down. A visible item was finished by
 * another delivery, under these same keys, so they stay.
 */
export async function withdrawIfHidden(
  queue: WorkQueueName,
  mediaId: string,
  keys: string[],
  signal: AbortSignal,
): Promise<void> {
  if (await isVisible(mediaId)) return;
  try {
    await deletePublicObjects(keys, { signal });
    console.log(`[worker] ${queue} media=${mediaId} was hidden while it was processed: its files were removed`);
  } catch (error) {
    console.error(
      `[worker] ${queue} media=${mediaId} was hidden while it was processed, and its files could not be removed (${keys.join(", ")}):`,
      describeError(error),
    );
  }
}

/**
 * Writes the item's manifest again from what the ready mark left. Tried three times, a short and
 * growing wait apart, since a retry of the whole job would find the item ready and do nothing. If
 * it still fails, the row is right and the album shows it; only a rebuild from R2 would read the
 * stale manifest, so the failure is said in the log.
 */
export async function rewriteManifest(
  queue: WorkQueueName,
  mediaId: string,
  manifest: MediaManifest,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await writeManifest(mediaId, manifest, { signal });
      return;
    } catch (error) {
      if (attempt >= MANIFEST_ATTEMPTS || signal.aborted) {
        console.error(`[worker] ${queue} media=${mediaId} is ready, but its manifest wasn't written:`, describeError(error));
        return;
      }
      await delay(MANIFEST_RETRY_MILLISECONDS * attempt, undefined, { signal }).catch(() => {});
    }
  }
}
