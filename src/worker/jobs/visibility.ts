import { purgeUrls, type PurgeOptions } from "@/lib/cloudflare/purge";
import { isUuid } from "@/lib/data/ids";
import { syncManifest } from "@/lib/media/manifest-sync";
import { deletableFrom, type VisibilityAction } from "@/lib/media/moderation";
import {
  addWithdrawingKeys,
  clearWithdrawnFiles,
  findItemToWithdraw,
  finishWithdrawing,
  type ItemToWithdraw,
} from "@/lib/media/rows";
import { isOriginalKey, publicUrl } from "@/lib/storage/keys";
import { deleteOriginal, deletePublicObjects, listDerivedKeys } from "@/lib/storage/objects";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";

/*
 * media.visibility: making "hidden" mean unreachable (Task 12). Its jobs come from moderation.ts
 * (a hide, a permanent delete, a manifest R2 refused), from a processing job whose files turned out
 * to be no one's (withdrawIfHidden), and from the sweeper (an item whose files no job is
 * withdrawing). Data `{ mediaId, action }`:
 *
 * - `hide`, for an item hidden, removed by its uploader, or deleted (or whose row is gone):
 *   1. lists every file under its public folder, then reads its row: a file there now was put up
 *      before the row was read, so if the row says hidden it is the hidden item's (an unhide after
 *      the read starts a new generation, whose files have keys of their own);
 *   2. records what it will withdraw on the row (withdrawing_keys): those files, the ones its row
 *      names, any an earlier attempt recorded, and a permanently deleted item's original. A retry
 *      (or the sweeper's job) withdraws them all, the ones the folder no longer lists included;
 *   3. deletes the public files and purges their exact URLs from Cloudflare's cache (purge.ts),
 *      then takes them off withdrawing_keys: what anyone can reach comes down first;
 *   4. deletes a permanently deleted item's original once its lock allows (deletableFrom), then
 *      takes it off too;
 *   5. clears the row's derived keys if they are still the ones withdrawn, so the sweeper stops
 *      looking for it;
 *   6. writes its manifest from the row (a deleted item's is removed).
 *   For an item visible again it withdraws only what is left recorded (an earlier attempt's, or a
 *   processing job's files of an older generation): never its current files, which its unhide made.
 * - `sync`: writes the item's manifest from its row, for a change whose own write R2 refused.
 *
 * A step that fails fails the job, which is retried with backoff (a missing purge token in
 * production too); every step is safe to repeat. A job delivered twice finds nothing left to
 * withdraw the second time (Ruling AG).
 */

export type VisibilityOptions = {
  /** How purges reach Cloudflare: its API and process.env's settings, unless a test points them elsewhere. */
  purge?: Pick<PurgeOptions, "apiUrl" | "env" | "timeoutMilliseconds">;
};

const ACTIONS: readonly string[] = ["hide", "sync"] satisfies VisibilityAction[];

/** The keys to withdraw now: for a visible item only what is recorded; otherwise everything it has, or had. */
function keysToWithdraw(item: ItemToWithdraw | null, listed: string[]): string[] {
  if (item?.visible) return [...new Set(item.withdrawingKeys)].sort();
  const recorded = item ? [...item.withdrawingKeys, ...Object.values(item.derived)] : [];
  return [...new Set([...recorded, ...listed])].sort();
}

/**
 * Deletes a permanently deleted item's original, never before its lock allows: an originals/ key is
 * recorded only by "Delete permanently", after its date check, and is checked again here.
 */
async function deleteOriginals(item: ItemToWithdraw | null, originals: string[], signal: AbortSignal): Promise<void> {
  if (originals.length === 0) return;
  const allowedFrom = item?.uploadedAt ? deletableFrom(item.uploadedAt) : null;
  if (!item?.deleted || !allowedFrom || Date.now() < allowedFrom.getTime()) {
    throw new Error(`An original is recorded for withdrawal, but its item isn't deleted, or its lock doesn't allow it yet`);
  }
  for (const key of originals) await deleteOriginal(key, { signal });
}

/** Withdraws an item's files: recorded, deleted, purged, then cleared. */
async function withdraw(job: MediaJob, mediaId: string, options: VisibilityOptions): Promise<JobReport> {
  // The folder before the row (see above).
  const listed = await listDerivedKeys(mediaId, { signal: job.signal });
  const item = await findItemToWithdraw(mediaId);
  const keys = keysToWithdraw(item, listed);
  if (keys.length > 0) {
    // A row that is gone (a cancelled upload, never processed) has nowhere to record them: this attempt's listing is all there is.
    if (item) await addWithdrawingKeys(mediaId, keys);
    const originals = keys.filter((key) => isOriginalKey(key));
    const publicKeys = keys.filter((key) => !isOriginalKey(key));
    // What anyone can reach comes down first: a refused original (its lock, or a passing fault)
    // fails the job only after the public files are deleted and purged, and the retry does the rest.
    await deletePublicObjects(publicKeys, { signal: job.signal });
    const purge = await purgeUrls(
      publicKeys.map((key) => publicUrl(key)),
      { ...options.purge, signal: job.signal },
    );
    if (item) await finishWithdrawing(mediaId, publicKeys);
    await deleteOriginals(item, originals, job.signal);
    if (item) await finishWithdrawing(mediaId, originals);
    console.log(
      `[worker] media.visibility media=${mediaId}: withdrew ${publicKeys.length} public file(s)${originals.length > 0 ? " and the original" : ""}` +
        ("skipped" in purge ? "; no purge, as CF_PURGE_TOKEN or CF_ZONE_ID isn't set (allowed outside production only)" : " and purged their URLs"),
    );
  }
  if (item?.visible) {
    if (keys.length === 0) console.log(`[worker] media.visibility job=${job.id}: nothing to do, media=${mediaId} is visible again`);
    return { kind: "hide" };
  }
  if (item && Object.keys(item.derived).length > 0) await clearWithdrawnFiles(mediaId, item.derived);
  await syncManifest(mediaId, { signal: job.signal });
  return { kind: "hide" };
}

/** media.visibility's work for one job, whose data is `{ mediaId, action }`. */
export async function runVisibilityJob(job: MediaJob, options: VisibilityOptions): Promise<JobReport> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const action = typeof job.data.action === "string" ? job.data.action : "";
  if (!isUuid(mediaId) || !ACTIONS.includes(action)) {
    throw new PermanentJobError("invalid-job", `A media.visibility job needs a media id and an action of ${ACTIONS.join(" or ")}`);
  }
  if (action === "sync") {
    await syncManifest(mediaId, { signal: job.signal });
    return { kind: "sync" };
  }
  return withdraw(job, mediaId, options);
}

/** media.visibility's handler, with the worker's settings. */
export function visibilityHandler(options: VisibilityOptions): MediaJobHandler {
  return (job) => runVisibilityJob(job, options);
}
