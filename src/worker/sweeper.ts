import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgBoss } from "pg-boss";
import { getDb } from "@/lib/db/client";
import type * as schema from "@/lib/db/schema";
import { media } from "@/lib/db/schema";
import { CONVERT_PRIORITY, MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { completeUpload, processingQueue } from "@/lib/media/completion";
import { unfinishedUploads, type UploadCursor } from "@/lib/media/rows";
import { mayContinueUpload, readUploadsSwitch } from "@/lib/media/uploads-switch";

/*
 * The sweeper makes sure no item stays "processing" for good. At start-up and every 10 minutes it:
 * 1. queues the processing of items `uploaded` more than 5 minutes ago that have no job (the app
 *    couldn't queue it: the queue was starting, or down), unless hidden or deleted;
 * 2. queues the conversion of `ready` videos whose conversion is `queued` with no job;
 * 3. (Ruling W) finishes uploads whose phone dropped during or just before its final complete:
 *    `uploading` for over 30 minutes, with every part in R2 adding up to the declared size, or the
 *    original already joined. Partial uploads are left for their guest to carry on; R2's 7-day
 *    rule clears the abandoned ones. Only uploads the couple's switch still allows (Ruling Z), as
 *    the complete route checks: once uploads close, an album upload is finished only if it began
 *    before the close and the 24 hours after it haven't passed. Wishes always are.
 * Each step handles a bounded batch, so a sweep is never unbounded; a backlog clears over a few.
 */

/** How often the sweeper runs. */
export const SWEEP_EVERY_MILLISECONDS = 10 * 60_000;

// Every age is measured by the database's clock (now()), the same clock that stamped the rows.
/** An item `uploaded` (or a conversion `queued`) this long with no job is stuck. */
const STUCK_AFTER_MINUTES = 5;
/** An upload older than this is no longer being sent by its phone. */
const ABANDONED_AFTER_MINUTES = 30;
/** R2 aborts unfinished multipart uploads after 7 days; past that (and a day's margin) there is nothing left to finish. */
const RESCUE_WITHIN_MINUTES = 8 * 24 * 60;
/**
 * The most items (or conversions) steps 1 and 2 look at in a sweep, oldest first. One stuck behind
 * more than this many older ones is found once that backlog drains, as the workers drain it.
 */
const CANDIDATE_BATCH_SIZE = 1_000;
/** The most items one sweep queues in each of steps 1 and 2. */
const REQUEUE_BATCH_SIZE = 100;
/** The most unfinished uploads one sweep checks in R2 (a ListParts each, and a complete for some). */
const RESCUE_BATCH_SIZE = 25;
/** The most one rescue's R2 calls may take together, as the complete route's budget. */
const RESCUE_BUDGET_MILLISECONDS = 40_000;

/** The queues an item's processing runs on, and media.dead, where a failed job waits to mark its item. */
const PROCESSING_QUEUES: MediaQueueName[] = [MEDIA_QUEUES.photo, MEDIA_QUEUES.poster, MEDIA_QUEUES.wish, MEDIA_QUEUES.dead];
const CONVERSION_QUEUES: MediaQueueName[] = [MEDIA_QUEUES.convert, MEDIA_QUEUES.dead];

export type SweepResult = {
  /** Step 1: items queued for processing. */
  requeuedUploads: number;
  /** Step 2: conversions queued. */
  requeuedConversions: number;
  /** Step 3: unfinished uploads looked at in R2, and those finished. */
  checkedUploads: number;
  rescuedUploads: number;
};

export type SweeperOptions = {
  boss: PgBoss;
  /** The schema pg-boss keeps its jobs in, which the sweeper reads to see which items have one. */
  bossSchema: string;
  /** Ends a sweep early: the worker is stopping. */
  signal?: AbortSignal;
  rescueBatchSize?: number;
};

/** What the sweeper's reads run on: the pool, or the read-only transaction steps 1 and 2 read in. */
type Reader = Pick<PostgresJsDatabase<typeof schema>, "select" | "execute">;

/** `now()` less this many minutes, in SQL: the database's clock, never the worker's. */
function minutesAgo(minutes: number): SQL {
  return sql`now() - make_interval(mins => ${minutes}::integer)`;
}

/**
 * Up to `limit` items `uploaded` more than 5 minutes ago, oldest first, read in order from the
 * partial index of uploaded items. Not a hidden or deleted one: its processing does nothing until
 * an unhide queues it again (Ruling AG). Exported for its plan's test.
 */
export function uploadedItemsQuery(limit: number, reader: Reader = getDb()) {
  return reader
    .select({ id: media.id, purpose: media.purpose, kind: media.kind })
    .from(media)
    .where(
      and(
        sql`${media.status} = 'uploaded'`,
        sql`${media.uploadedAt} < ${minutesAgo(STUCK_AFTER_MINUTES)}`,
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
      ),
    )
    .orderBy(asc(media.uploadedAt))
    .limit(limit);
}

/**
 * Up to `limit` ready videos whose conversion is `queued`, last queued (on becoming ready, or when
 * a phone asked) more than 5 minutes ago, oldest first, on the partial index of queued
 * conversions. Exported for its plan's test.
 */
export function queuedConversionsQuery(limit: number, reader: Reader = getDb()) {
  return reader
    .select({ id: media.id, onDemand: sql<boolean>`${media.highlight} or ${media.conversionRequestedAt} is not null` })
    .from(media)
    .where(
      and(
        sql`${media.status} = 'ready'`,
        sql`${media.conversion} = 'queued'`,
        eq(media.kind, "video"),
        sql`greatest(${media.listedAt}, ${media.conversionRequestedAt}) < ${minutesAgo(STUCK_AFTER_MINUTES)}`,
      ),
    )
    .orderBy(asc(media.listedAt))
    .limit(limit);
}

/**
 * The query behind itemsWithLiveJobs, exported for its plan's test: these items' live jobs
 * (waiting, retrying or running) on these queues, read from pg-boss's job table. That is pg-boss
 * 12's own table (the parent of every queue's partition), whose index of live jobs covers name and
 * state; package.json pins pg-boss exactly, so an upgrade that changes it is a deliberate one, and
 * it fails these tests.
 */
export function liveJobsQuery(bossSchema: string, queues: MediaQueueName[], mediaIds: string[]): SQL {
  const names = sql.join(
    queues.map((name) => sql`${name}`),
    sql`, `,
  );
  return sql`select distinct job.data ->> 'mediaId' as "mediaId" from ${sql.identifier(bossSchema)}.job as job
    where job.name in (${names})
      and job.state in ('created', 'retry', 'active')
      and ${inArray(sql`job.data ->> 'mediaId'`, mediaIds)}`;
}

/**
 * Which of these items have a live job on these queues. One query for the batch, and only for its
 * ids: the live jobs are read once by queue and state, never once per item, so it stays linear
 * however stale the planner's statistics are after a burst.
 */
async function itemsWithLiveJobs(
  reader: Reader,
  bossSchema: string,
  queues: MediaQueueName[],
  mediaIds: string[],
): Promise<Set<string>> {
  if (mediaIds.length === 0) return new Set();
  const rows = await reader.execute<{ mediaId: string }>(liveJobsQuery(bossSchema, queues, mediaIds));
  return new Set(rows.map((row) => row.mediaId));
}

/**
 * Up to a batch of the candidates `readCandidates` finds that have no live job on these queues.
 * Both reads see one snapshot (a read-only, repeatable-read transaction), so a job that finishes
 * between them, its item no longer stuck, can't look missing and have its item queued again. The
 * transaction holds no locks and makes no network call; the jobs are queued after it ends.
 */
function stuckAmong<TCandidate extends { id: string }>(
  bossSchema: string,
  queues: MediaQueueName[],
  readCandidates: (reader: Reader) => Promise<TCandidate[]>,
): Promise<TCandidate[]> {
  return getDb().transaction(
    async (transaction) => {
      const candidates = await readCandidates(transaction);
      const withJobs = await itemsWithLiveJobs(
        transaction,
        bossSchema,
        queues,
        candidates.map((candidate) => candidate.id),
      );
      return candidates.filter((candidate) => !withJobs.has(candidate.id)).slice(0, REQUEUE_BATCH_SIZE);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function createSweeper(options: SweeperOptions) {
  const { boss, bossSchema, signal } = options;
  const rescueBatchSize = options.rescueBatchSize ?? RESCUE_BATCH_SIZE;
  // Where step 3 stopped, so the next sweep carries on from there and every upload gets its turn.
  let rescueCursor: UploadCursor | null = null;

  /** Step 1: items stuck in `uploaded` with no job, queued on their processing queue. */
  async function requeueUploads(): Promise<number> {
    const stuck = await stuckAmong(bossSchema, PROCESSING_QUEUES, (reader) =>
      uploadedItemsQuery(CANDIDATE_BATCH_SIZE, reader),
    );
    const byQueue = Map.groupBy(stuck, (item) => processingQueue(item));
    for (const [queue, items] of byQueue) {
      await boss.insert(
        queue,
        items.map((item) => ({ data: { mediaId: item.id } })),
      );
    }
    return stuck.length;
  }

  /** Step 2: ready videos whose conversion is `queued` with no job: on demand if anyone asked, else the backlog. */
  async function requeueConversions(): Promise<number> {
    const stuck = await stuckAmong(bossSchema, CONVERSION_QUEUES, (reader) =>
      queuedConversionsQuery(CANDIDATE_BATCH_SIZE, reader),
    );
    if (stuck.length > 0) {
      await boss.insert(
        MEDIA_QUEUES.convert,
        stuck.map((item) => ({
          data: { mediaId: item.id },
          priority: item.onDemand ? CONVERT_PRIORITY.onDemand : CONVERT_PRIORITY.backlog,
        })),
      );
    }
    return stuck.length;
  }

  /**
   * Step 3 (Ruling W): one batch of unfinished uploads, each completed if R2 holds all of it. An
   * upload the uploads switch no longer allows (Ruling Z) is left exactly as it is: not aborted and
   * its row not deleted, since its original may exist already; R2's 7-day rule clears its parts.
   */
  async function rescueUploads(): Promise<{ checked: number; rescued: number }> {
    // Read once a sweep, as each route reads it once a request. Unreadable, the step fails: closed.
    const uploadsSwitch = await readUploadsSwitch();
    const page = await unfinishedUploads({
      startedMoreThanMinutesAgo: ABANDONED_AFTER_MINUTES,
      startedWithinMinutes: RESCUE_WITHIN_MINUTES,
      cursor: rescueCursor,
      limit: rescueBatchSize,
    });
    // A short page is the last: the next sweep starts from the oldest again.
    const last = page.at(-1);
    rescueCursor = page.length < rescueBatchSize || !last ? null : { startedAt: last.startedAt, id: last.id };
    const uploads = page.filter((upload) => mayContinueUpload(upload, uploadsSwitch));
    let rescued = 0;
    for (const upload of uploads) {
      signal?.throwIfAborted();
      // completeUpload queues the job after it marks the row; here it runs at once, and is awaited.
      const queued: Promise<void>[] = [];
      const budget = AbortSignal.timeout(RESCUE_BUDGET_MILLISECONDS);
      try {
        const outcome = await completeUpload(upload, {
          signal: signal ? AbortSignal.any([signal, budget]) : budget,
          defer: (task) => queued.push(task()),
        });
        await Promise.all(queued);
        if (outcome === "uploaded") {
          rescued += 1;
          console.log(`[worker] sweeper finished upload ${upload.id}, which its phone left at the last step`);
        }
      } catch (error) {
        console.error(`[worker] sweeper could not check upload ${upload.id}:`, describeError(error));
      }
    }
    return { checked: uploads.length, rescued };
  }

  /** One sweep: the three steps, each on its own, so one failing doesn't stop the others. */
  async function sweep(): Promise<SweepResult> {
    const result: SweepResult = { requeuedUploads: 0, requeuedConversions: 0, checkedUploads: 0, rescuedUploads: 0 };
    try {
      result.requeuedUploads = await requeueUploads();
    } catch (error) {
      console.error("[worker] sweeper could not queue stuck uploads:", describeError(error));
    }
    try {
      result.requeuedConversions = await requeueConversions();
    } catch (error) {
      console.error("[worker] sweeper could not queue stuck conversions:", describeError(error));
    }
    try {
      const { checked, rescued } = await rescueUploads();
      result.checkedUploads = checked;
      result.rescuedUploads = rescued;
    } catch (error) {
      if (signal?.aborted) return result;
      console.error("[worker] sweeper could not check unfinished uploads:", describeError(error));
    }
    if (result.requeuedUploads > 0 || result.requeuedConversions > 0 || result.rescuedUploads > 0) {
      console.log(
        `[worker] sweep queued ${result.requeuedUploads} upload(s) and ${result.requeuedConversions} conversion(s), and finished ${result.rescuedUploads} of ${result.checkedUploads} unfinished upload(s)`,
      );
    }
    return result;
  }

  return { sweep };
}

export type Sweeper = ReturnType<typeof createSweeper>;

/**
 * Sweeps now and then every 10 minutes, each sweep starting only once the last has ended, until
 * `signal` aborts. Returns at once; the sweeps run in the background.
 */
export function startSweeping(sweeper: Sweeper, signal: AbortSignal, everyMilliseconds = SWEEP_EVERY_MILLISECONDS): void {
  let timer: NodeJS.Timeout | undefined;
  const sweepThenWait = async () => {
    if (signal.aborted) return;
    await sweeper.sweep();
    if (!signal.aborted) timer = setTimeout(sweepThenWait, everyMilliseconds);
  };
  signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  void sweepThenWait();
}
