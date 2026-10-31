import { deleteManifest, writeManifest, type MediaManifest } from "@/lib/storage/manifest";
import { manifestFacts } from "./rows";

/*
 * Every write of an item's manifest goes through syncManifest, from the app (an upload's start,
 * moderation) and the media worker (a ready mark, the visibility job) alike. The worker bundles this
 * file, so it reaches nothing from next/.
 *
 * Two writers can race: a processing job reads the facts its ready mark left, a hide changes them
 * and writes its own manifest, then the job's older write lands last. So each writer, once its PUT
 * has landed, reads the row again and writes again until what it wrote is what the row says. The
 * last PUT to land is followed by its writer's check, which catches it if it was stale: the
 * manifest ends as the row is. No transaction is held across the PUT.
 */

/** A writer that keeps finding the row changed gives up after this many writes, and says so by throwing. */
const MAX_WRITES = 5;

export type ManifestSyncOptions = {
  /** Bounds each R2 call with the caller's signal (a request's, or a job's), beside its 15 s deadline. */
  signal?: AbortSignal;
  /** The facts as a statement just left them (a ready mark's RETURNING), written first without reading them. */
  known?: MediaManifest;
};

/** What syncManifest left: a manifest as the row is, or none for an item deleted or gone. */
export type ManifestSyncResult = "written" | "removed";

function sameFacts(written: MediaManifest, current: MediaManifest): boolean {
  const sameTime = (first: Date | null, second: Date | null) => (first?.getTime() ?? null) === (second?.getTime() ?? null);
  return (
    written.celebration === current.celebration &&
    written.celebrationSetByAdmin === current.celebrationSetByAdmin &&
    sameTime(written.hiddenAt, current.hiddenAt) &&
    written.hiddenBy === current.hiddenBy &&
    written.removedByUploader === current.removedByUploader &&
    sameTime(written.deletedAt, current.deletedAt)
  );
}

/**
 * Writes the item's manifest from its row, then reads the row again and writes again until the two
 * agree, so a write that raced another never leaves a stale manifest. A deleted item, or one whose
 * row is gone (a cancelled upload), has its manifest removed instead: nothing may bring back what
 * was deleted. Throws when R2 refuses (or the row changes five writes running); callers retry, or
 * leave it to the visibility job's retries.
 */
export async function syncManifest(mediaId: string, options: ManifestSyncOptions = {}): Promise<ManifestSyncResult> {
  let facts = options.known ?? (await manifestFacts(mediaId));
  for (let writes = 1; ; writes += 1) {
    if (!facts || facts.deletedAt) {
      await deleteManifest(mediaId, { signal: options.signal });
      return "removed";
    }
    await writeManifest(mediaId, facts, { signal: options.signal });
    const current = await manifestFacts(mediaId);
    if (current && sameFacts(facts, current)) return "written";
    if (writes >= MAX_WRITES) throw new Error(`media=${mediaId}'s row kept changing while its manifest was written`);
    facts = current;
  }
}
