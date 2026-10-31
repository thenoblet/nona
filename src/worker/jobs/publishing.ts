import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PgBoss } from "pg-boss";
import { describeError } from "@/lib/log-error";
import { syncManifest } from "@/lib/media/manifest-sync";
import { sendVisibilityJob } from "@/lib/media/moderation";
import { addWithdrawingKeys, findItemToWithdraw } from "@/lib/media/rows";
import type { MediaManifest } from "@/lib/storage/manifest";
import { deletePublicObjects } from "@/lib/storage/objects";
import type { WorkQueueName } from "../queues";

/*
 * What every processing job (a photo's, a video's poster, a conversion) does around its ready mark:
 * names its derived files by a content hash, takes them down again when the item was hidden while
 * it worked, and writes the item's manifest again once it is ready.
 */

/** Hex characters of the content hash kept in a key: 64 bits, beside the item's own id. */
const CONTENT_HASH_CHARACTERS = 16;
/** The manifest's write is tried this many times after the ready mark, a short and growing wait apart. */
const MANIFEST_ATTEMPTS = 3;
const MANIFEST_RETRY_MILLISECONDS = 250;

/**
 * The derived files' content hash: the original's ETag (its bytes never change), the job's
 * settings, such as "photo-settings-1", and the item's generation (derived_generation). A job
 * raises its settings' version whenever what it makes changes (a size, a quality), and every unhide
 * raises the generation, so the files made again get new keys, which no cache has seen and no hide
 * still deleting can touch. The first generation's keys are as they always were.
 */
export function contentHashOf(etag: string, settings: string, generation = 0): string {
  const versioned = generation === 0 ? settings : `${settings}\ngeneration-${generation}`;
  return createHash("sha256").update(`${etag}\n${versioned}`).digest("hex").slice(0, CONTENT_HASH_CHARACTERS);
}

/** Where a processing job sends the visibility job that withdraws what it published for an item hidden meanwhile. */
export type JobQueue = () => Promise<Pick<PgBoss, "send">>;

/**
 * After a ready mark that changed nothing. An item still visible in the generation the job made
 * its files for was finished by another delivery, under these same keys, so they stay. Otherwise
 * the files are no one's: the item was hidden, deleted or gone while the job worked, or unhidden
 * into a new generation since it read the item (and a hide may have purged these very URLs before
 * the job put them back). So they are recorded as withdrawing (withdrawing_keys) and come down at
 * once, and media.visibility `hide` is queued whatever that did: it deletes them and anything left
 * under a hidden item's folder, and purges the URLs from Cloudflare, retried until done.
 */
export async function withdrawIfHidden(
  queue: WorkQueueName,
  mediaId: string,
  keys: string[],
  options: { signal: AbortSignal; jobQueue: JobQueue; derivedGeneration: number },
): Promise<void> {
  const item = await findItemToWithdraw(mediaId);
  if (item?.visible && item.derivedGeneration === options.derivedGeneration) return;
  // What happened to the item while the job worked, for the log: ids only.
  const happened = !item
    ? "is gone"
    : item.deleted
      ? "was deleted while it was processed"
      : item.visible
        ? "was unhidden into a new generation while it was processed"
        : "was hidden while it was processed";
  const subject = `[worker] ${queue} media=${mediaId} ${happened}`;
  try {
    if (item) await addWithdrawingKeys(mediaId, keys);
  } catch (error) {
    console.error(`${subject}, and the withdrawal of its files couldn't be recorded:`, describeError(error));
  }
  try {
    await deletePublicObjects(keys, { signal: options.signal });
    console.log(`${subject}: the files it made were removed`);
  } catch (error) {
    console.error(`${subject}, and the files it made could not be removed (${keys.join(", ")}); the visibility job will:`, describeError(error));
  }
  try {
    await sendVisibilityJob(mediaId, "hide", options.jobQueue);
  } catch (error) {
    console.error(`${subject}, and its withdrawal wasn't queued:`, describeError(error));
  }
}

/**
 * Writes the item's manifest again after its ready mark: from what the mark left, then as the row
 * is, until the two agree (syncManifest), so a hide that landed meanwhile is never lost. Tried
 * three times, a short and growing wait apart, since a retry of the whole job would find the item
 * ready and do nothing. If it still fails, the row is right and the album shows it; only a rebuild
 * from R2 would read the stale manifest, so the failure is said in the log.
 */
export async function rewriteManifest(
  queue: WorkQueueName,
  mediaId: string,
  manifest: MediaManifest,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // The first write from the mark's facts; later attempts read the row afresh.
      await syncManifest(mediaId, { known: attempt === 1 ? manifest : undefined, signal });
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
