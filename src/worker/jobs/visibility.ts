import { purgeUrls, type PurgeOptions } from "@/lib/cloudflare/purge";
import { isUuid } from "@/lib/data/ids";
import { syncManifest } from "@/lib/media/manifest-sync";
import type { VisibilityAction } from "@/lib/media/moderation";
import { clearWithdrawnFiles, findItemToWithdraw } from "@/lib/media/rows";
import { publicUrl } from "@/lib/storage/keys";
import { deletePublicObjects, listDerivedKeys } from "@/lib/storage/objects";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";

/*
 * media.visibility: making "hidden" mean unreachable (Task 12). Its jobs come from moderation.ts
 * (a hide, a permanent delete, a manifest R2 refused), from a processing job that finished for an
 * item hidden meanwhile (withdrawIfHidden), and from the sweeper (a hidden item whose files no job
 * is withdrawing). Data `{ mediaId, action }`:
 *
 * - `hide`, for an item hidden, removed by its uploader, or deleted (or whose row is gone):
 *   1. lists every file under its public folder, then reads its row: a file there now was put up
 *      before the row was read, so if the row says hidden it is the hidden item's (an unhide after
 *      the read starts a new generation, whose files have keys of their own);
 *   2. deletes those files and the ones its row names from the public bucket;
 *   3. purges their exact URLs from Cloudflare's cache (purge.ts);
 *   4. clears the row's keys, only if they are still the ones withdrawn, so the sweeper stops
 *      looking for it;
 *   5. writes its manifest from the row (a deleted item's is removed).
 *   A step that fails fails the job, which is retried with backoff (a missing purge token in
 *   production too); every step is safe to repeat. For an item visible again, it does nothing: its
 *   unhide makes its files again.
 * - `sync`: writes the item's manifest from its row, for a change whose own write R2 refused.
 *
 * A job delivered twice finds nothing left to delete or purge the second time (Ruling AG).
 */

export type VisibilityOptions = {
  /** How purges reach Cloudflare: its API and process.env's settings, unless a test points them elsewhere. */
  purge?: Pick<PurgeOptions, "apiUrl" | "env" | "timeoutMilliseconds">;
};

const ACTIONS: readonly string[] = ["hide", "sync"] satisfies VisibilityAction[];

/** Withdraws a hidden or deleted item's public files: deleted, purged, then its keys cleared. */
async function withdraw(job: MediaJob, mediaId: string, options: VisibilityOptions): Promise<JobReport> {
  // The folder before the row (see above).
  const listed = await listDerivedKeys(mediaId, { signal: job.signal });
  const item = await findItemToWithdraw(mediaId);
  if (item?.visible) {
    console.log(`[worker] media.visibility job=${job.id}: nothing to do, media=${mediaId} is visible again`);
    return { kind: "hide" };
  }
  const named = item ? Object.values(item.derived) : [];
  const keys = [...new Set([...named, ...listed])].sort();
  if (keys.length > 0) {
    await deletePublicObjects(keys, { signal: job.signal });
    const purge = await purgeUrls(
      keys.map((key) => publicUrl(key)),
      { ...options.purge, signal: job.signal },
    );
    console.log(
      "skipped" in purge
        ? `[worker] media.visibility media=${mediaId}: deleted ${keys.length} file(s); no purge, as CF_PURGE_TOKEN or CF_ZONE_ID isn't set (allowed outside production only)`
        : `[worker] media.visibility media=${mediaId}: deleted ${keys.length} file(s) and purged their URLs`,
    );
  }
  if (item && named.length > 0) await clearWithdrawnFiles(mediaId, item.derived);
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
