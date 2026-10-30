import { and, eq, lt, notExists, sql, type SQL } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { CONVERT_PRIORITY, MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { completeUpload, processingQueue } from "@/lib/media/completion";
import { unfinishedUploads, type UploadCursor } from "@/lib/media/rows";

/*
 * The sweeper makes sure no item stays "processing" for good. At start-up and every 10 minutes it:
 * 1. queues the processing of items `uploaded` more than 5 minutes ago that have no job (the app
 *    couldn't queue it: the queue was starting, or down);
 * 2. queues the conversion of `ready` videos whose conversion is `queued` with no job;
 * 3. (Ruling W) finishes uploads whose phone dropped during or just before its final complete:
 *    `uploading` for over 30 minutes, with every part in R2 adding up to the declared size, or the
 *    original already joined. Partial uploads are left for their guest to carry on; R2's 7-day
 *    rule clears the abandoned ones.
 * Each step handles a bounded batch, so a sweep is never unbounded; a backlog clears over a few.
 */

/** How often the sweeper runs. */
export const SWEEP_EVERY_MILLISECONDS = 10 * 60_000;

const MINUTE = 60_000;
/** An item `uploaded` (or a conversion `queued`) this long with no job is stuck. */
const STUCK_AFTER_MILLISECONDS = 5 * MINUTE;
/** An upload older than this is no longer being sent by its phone. */
const ABANDONED_AFTER_MILLISECONDS = 30 * MINUTE;
/** R2 aborts unfinished multipart uploads after 7 days; past that (and a day's margin) there is nothing left to finish. */
const RESCUE_WITHIN_MILLISECONDS = 8 * 24 * 60 * MINUTE;
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

/**
 * Whether the item has a live job (waiting, retrying or running) on one of these queues, read
 * straight from pg-boss's job table: one query for the whole batch, rather than one per item. That
 * is pg-boss 12's own table (the parent of every queue's partition), whose index of live jobs
 * covers name and state; a pg-boss upgrade that changes it fails the sweeper's tests.
 */
function hasLiveJob(bossSchema: string, queues: MediaQueueName[]): SQL {
  const names = sql.join(
    queues.map((name) => sql`${name}`),
    sql`, `,
  );
  return sql`(select 1 from ${sql.identifier(bossSchema)}.job as job
    where job.name in (${names})
      and job.state in ('created', 'retry', 'active')
      and job.data ->> 'mediaId' = ${media.id}::text)`;
}

function timeAgo(milliseconds: number): Date {
  return new Date(Date.now() - milliseconds);
}

/**
 * Items `uploaded` more than 5 minutes ago with no live job: at most `limit`. One query, on the
 * partial index of uploaded items, with pg-boss's index of live jobs for each. Exported for its
 * plan's test.
 */
export function stuckUploadsQuery(bossSchema: string, limit: number) {
  return getDb()
    .select({ id: media.id, purpose: media.purpose, kind: media.kind })
    .from(media)
    .where(
      and(
        sql`${media.status} = 'uploaded'`,
        lt(media.uploadedAt, timeAgo(STUCK_AFTER_MILLISECONDS)),
        notExists(hasLiveJob(bossSchema, PROCESSING_QUEUES)),
      ),
    )
    .limit(limit);
}

/**
 * Ready videos whose conversion is `queued`, last queued more than 5 minutes ago, with no live job:
 * at most `limit`. On the partial index of queued conversions. Exported for its plan's test.
 */
export function stuckConversionsQuery(bossSchema: string, limit: number) {
  return getDb()
    .select({ id: media.id, onDemand: sql<boolean>`${media.highlight} or ${media.conversionRequestedAt} is not null` })
    .from(media)
    .where(
      and(
        sql`${media.status} = 'ready'`,
        sql`${media.conversion} = 'queued'`,
        eq(media.kind, "video"),
        // When it was last queued: on becoming ready, or when a phone asked for it.
        sql`greatest(${media.listedAt}, ${media.conversionRequestedAt}) < ${timeAgo(STUCK_AFTER_MILLISECONDS).toISOString()}::timestamptz`,
        notExists(hasLiveJob(bossSchema, CONVERSION_QUEUES)),
      ),
    )
    .limit(limit);
}

export function createSweeper(options: SweeperOptions) {
  const { boss, bossSchema, signal } = options;
  const rescueBatchSize = options.rescueBatchSize ?? RESCUE_BATCH_SIZE;
  // Where step 3 stopped, so the next sweep carries on from there and every upload gets its turn.
  let rescueCursor: UploadCursor | null = null;

  /** Step 1: items stuck in `uploaded` with no job, queued on their processing queue. */
  async function requeueUploads(): Promise<number> {
    const stuck = await stuckUploadsQuery(bossSchema, REQUEUE_BATCH_SIZE);
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
    const stuck = await stuckConversionsQuery(bossSchema, REQUEUE_BATCH_SIZE);
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

  /** Step 3 (Ruling W): one batch of unfinished uploads, each completed if R2 holds all of it. */
  async function rescueUploads(): Promise<{ checked: number; rescued: number }> {
    const uploads = await unfinishedUploads({
      startedBefore: timeAgo(ABANDONED_AFTER_MILLISECONDS),
      startedAfter: timeAgo(RESCUE_WITHIN_MILLISECONDS),
      cursor: rescueCursor,
      limit: rescueBatchSize,
    });
    // A short page is the last: the next sweep starts from the oldest again.
    const last = uploads.at(-1);
    rescueCursor = uploads.length < rescueBatchSize || !last ? null : { startedAt: last.startedAt, id: last.id };
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
