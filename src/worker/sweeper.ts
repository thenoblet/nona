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
import type { PlayableJobData } from "./jobs/playable";

/*
 * The sweeper makes sure no item stays "processing" for good. At start-up and every 10 minutes it:
 * 1. queues the processing of items `uploaded` more than 5 minutes ago that have no job (the app
 *    couldn't queue it: the queue was starting, or down), unless hidden or deleted;
 * 2. queues the conversion of `ready`, visible videos whose conversion is `queued` with no job, or,
 *    for one a phone asked for or the couple made a highlight, no on-demand job (its backlog job may
 *    wait behind the switch for days); and puts back to `queued`, and queues again, one left
 *    `converting` that no job will carry on (Ruling AQ): its job is gone, or, for an on-demand one,
 *    only waits in the backlog;
 * 3. (Ruling W) finishes uploads whose phone dropped during or just before its final complete:
 *    `uploading` for over 30 minutes, with every part in R2 adding up to the declared size, or the
 *    original already joined. Partial uploads are left for their guest to carry on; R2's 7-day
 *    rule clears the abandoned ones. Only uploads the couple's switch still allows (Ruling Z), as
 *    the complete route checks: once uploads close, an album upload is finished only if it began
 *    before the close and the 24 hours after it haven't passed. Wishes always are;
 * 4. (Task 12) queues media.visibility `hide` for items hidden, removed or deleted more than 5
 *    minutes ago whose row still names public files, and for items with a withdrawal under way
 *    (withdrawing_keys), when no job is withdrawing them (the app couldn't queue one, or it failed
 *    for good): a hidden item's files never stay public, or cached, for want of a job;
 * 5. (Task 14b) queues media.playable for ready, visible album videos with no playable copy that
 *    one is made for (HEVC, or H.264 every phone plays), listed between 5 minutes and 6 days ago,
 *    that have never had a media.playable job for their generation, in any state: the poster
 *    job's send was lost. pg-boss keeps a finished job 7 days, so a copy whose job finished without
 *    one or failed for good is never sent again, and a lost send is sent once. A job that names no
 *    generation (sent before jobs named one) counts for every generation.
 * Each step handles a bounded batch, so a sweep is never unbounded; a backlog clears over a few.
 */

/** How often the sweeper runs. */
export const SWEEP_EVERY_MILLISECONDS = 10 * 60_000;

// Every age is measured by the database's clock (now()), the same clock that stamped the rows.
/** An item `uploaded` (or a conversion `queued`) this long with no job is stuck. */
const STUCK_AFTER_MINUTES = 5;
/** An upload older than this is no longer being sent by its phone. */
const ABANDONED_AFTER_MINUTES = 30;
/**
 * Step 5 looks at videos listed within this many minutes: 6 days, inside the 7 days pg-boss keeps
 * a finished media.playable job (its deleteAfterSeconds, stated in media-queues.ts), so a video
 * whose copy's job ran is always seen to have had one.
 */
const COPY_WITHIN_MINUTES = 6 * 24 * 60;
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
const WITHDRAWAL_QUEUES: MediaQueueName[] = [MEDIA_QUEUES.visibility, MEDIA_QUEUES.dead];

export type SweepResult = {
  /** Step 1: items queued for processing. */
  requeuedUploads: number;
  /** Step 2: conversions queued, and of them, those recovered from a `converting` no job will carry on. */
  requeuedConversions: number;
  recoveredConversions: number;
  /** Step 3: unfinished uploads looked at in R2, and those finished. */
  checkedUploads: number;
  rescuedUploads: number;
  /** Step 4: hidden or deleted items whose public files were sent to be withdrawn. */
  requeuedWithdrawals: number;
  /** Step 5: videos whose playable copy's job was never sent, sent now. */
  requeuedCopies: number;
};

export type SweeperOptions = {
  boss: PgBoss;
  /** The schema pg-boss keeps its jobs in, which the sweeper reads to see which items have one. */
  bossSchema: string;
  /** Ends a sweep early: the worker is stopping. */
  signal?: AbortSignal;
  rescueBatchSize?: number;
};

/** A conversion step 2 looks at: on demand when a phone asked for it or it is a highlight. */
type ConversionCandidate = { id: string; onDemand: boolean };

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
 * Up to `limit` ready, visible videos whose conversion is `queued`, last queued (on becoming ready,
 * or when a phone asked) more than 5 minutes ago, oldest first, on the partial index of queued
 * conversions. Not a hidden or deleted one: its job would do nothing, and every sweep would send it
 * again; an unhide brings it back. Exported for its plan's test.
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
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        sql`greatest(${media.listedAt}, ${media.conversionRequestedAt}) < ${minutesAgo(STUCK_AFTER_MINUTES)}`,
      ),
    )
    .orderBy(asc(media.listedAt))
    .limit(limit);
}

/**
 * Up to `limit` ready, visible videos whose conversion is `converting`, oldest first, on the
 * partial index of conversions under way: the ones whose job the sweeper checks is still there
 * (Ruling AQ). Exported for its plan's test.
 */
export function convertingConversionsQuery(limit: number, reader: Reader = getDb()) {
  return reader
    .select({ id: media.id, onDemand: sql<boolean>`${media.highlight} or ${media.conversionRequestedAt} is not null` })
    .from(media)
    .where(
      and(
        sql`${media.status} = 'ready'`,
        sql`${media.conversion} = 'converting'`,
        eq(media.kind, "video"),
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
      ),
    )
    .orderBy(asc(media.listedAt))
    .limit(limit);
}

/**
 * Up to `limit` items hidden (or removed by their uploader) or deleted more than 5 minutes ago whose
 * row still names public files, or with a withdrawal under way (withdrawing_keys: only a job sets
 * them, so they need no wait), on the partial index of such items: a handful at most, so no order.
 * Exported for its plan's test.
 */
export function withdrawalsQuery(limit: number, reader: Reader = getDb()) {
  return reader
    .select({ id: media.id })
    .from(media)
    .where(
      // Each arm implies the partial index's own condition, so Postgres proves it applies. greatest()
      // passes over a null: whichever of the two happened.
      sql`((${media.hiddenAt} is not null or ${media.deletedAt} is not null) and ${media.derived} <> '{}'::jsonb
          and greatest(${media.hiddenAt}, ${media.deletedAt}) < ${minutesAgo(STUCK_AFTER_MINUTES)})
        or ${media.withdrawingKeys} is not null`,
    )
    .limit(limit);
}

/**
 * Up to `limit` ready, visible album videos a playable copy is made for (HEVC, or H.264 every phone
 * plays: one that isn't may have sound an MP4 doesn't carry as it is, and gets none) with no
 * playable copy, listed between 5 minutes and 6 days ago, oldest first, with their generation:
 * read backwards along the album's own index (media_album_cursor_idx), whose condition the query
 * repeats as literals, so no sort. Exported for its plan's test.
 */
export function missingCopiesQuery(limit: number, reader: Reader = getDb()) {
  return reader
    .select({ id: media.id, generation: media.derivedGeneration })
    .from(media)
    .where(
      and(
        eq(media.purpose, "album"),
        sql`${media.status} = 'ready'`,
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        eq(media.removedByUploader, false),
        eq(media.kind, "video"),
        sql`(${media.videoCodec} = 'hevc' or (${media.videoCodec} = 'h264' and ${media.browserPlayable}))`,
        sql`${media.derived} ->> 'playable' is null`,
        sql`${media.listedAt} > ${minutesAgo(COPY_WITHIN_MINUTES)}`,
        sql`${media.listedAt} < ${minutesAgo(STUCK_AFTER_MINUTES)}`,
      ),
    )
    .orderBy(asc(media.listedAt), asc(media.id))
    .limit(limit);
}

/**
 * These items' media.playable jobs in any state, live or finished (pg-boss keeps a finished one 7
 * days), each item with the generation its job names (null for none), on pg-boss's index of a
 * queue's jobs by name. Exported for its plan's test.
 */
export function copyJobsQuery(bossSchema: string, mediaIds: string[]): SQL {
  return sql`select distinct job.data ->> 'mediaId' as "mediaId", job.data ->> 'generation' as "generation"
    from ${sql.identifier(bossSchema)}.job as job
    where job.name = ${MEDIA_QUEUES.playable} and ${inArray(sql`job.data ->> 'mediaId'`, mediaIds)}`;
}

/**
 * The query behind itemsWithLiveJobs, exported for its plan's test: these items' live jobs
 * (waiting, retrying or running) on these queues, read from pg-boss's job table. That is pg-boss
 * 12's own table (the parent of every queue's partition), whose index of live jobs covers name and
 * state; package.json pins pg-boss exactly, so an upgrade that changes it is a deliberate one, and
 * it fails these tests. With `minConvertPriority`, a media.convert job counts only at that priority
 * or above, or while it runs (an on-demand conversion's backlog job waiting doesn't); other queues'
 * jobs (media.dead's) count.
 */
export function liveJobsQuery(
  bossSchema: string,
  queues: MediaQueueName[],
  mediaIds: string[],
  minConvertPriority?: number,
): SQL {
  const names = sql.join(
    queues.map((name) => sql`${name}`),
    sql`, `,
  );
  const priority =
    minConvertPriority === undefined
      ? sql``
      : sql` and (job.name <> ${MEDIA_QUEUES.convert} or job.priority >= ${minConvertPriority} or job.state = 'active')`;
  return sql`select distinct job.data ->> 'mediaId' as "mediaId" from ${sql.identifier(bossSchema)}.job as job
    where job.name in (${names})
      and job.state in ('created', 'retry', 'active')
      and ${inArray(sql`job.data ->> 'mediaId'`, mediaIds)}${priority}`;
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
  minConvertPriority?: number,
): Promise<Set<string>> {
  if (mediaIds.length === 0) return new Set();
  const rows = await reader.execute<{ mediaId: string }>(liveJobsQuery(bossSchema, queues, mediaIds, minConvertPriority));
  return new Set(rows.map((row) => row.mediaId));
}

/**
 * Up to a batch of the candidates `readCandidates` finds that `readItemsWithJobs` says have no job.
 * Both reads see one snapshot (a read-only, repeatable-read transaction), so a job that finishes
 * between them, its item no longer stuck, can't look missing and have its item queued again. The
 * transaction holds no locks and makes no network call; the jobs are queued after it ends.
 */
function amongWithoutJobs<TCandidate extends { id: string }>(
  readCandidates: (reader: Reader) => Promise<TCandidate[]>,
  readItemsWithJobs: (reader: Reader, candidates: TCandidate[]) => Promise<Set<string>>,
): Promise<TCandidate[]> {
  return getDb().transaction(
    async (transaction) => {
      const candidates = await readCandidates(transaction);
      if (candidates.length === 0) return [];
      const withJobs = await readItemsWithJobs(transaction, candidates);
      return candidates.filter((candidate) => !withJobs.has(candidate.id)).slice(0, REQUEUE_BATCH_SIZE);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/**
 * Up to a batch of the candidates `readCandidates` finds that have no live job on these queues (at
 * least `minConvertPriorityOf` the candidate, for a conversion, when it gives one), in one snapshot
 * (amongWithoutJobs). At most two reads of the live jobs: one for each minimum priority the
 * candidates have.
 */
function stuckAmong<TCandidate extends { id: string }>(
  bossSchema: string,
  queues: MediaQueueName[],
  readCandidates: (reader: Reader) => Promise<TCandidate[]>,
  minConvertPriorityOf: (candidate: TCandidate) => number | undefined = () => undefined,
): Promise<TCandidate[]> {
  return amongWithoutJobs(readCandidates, async (reader, candidates) => {
    const withJobs = new Set<string>();
    for (const [minConvertPriority, group] of Map.groupBy(candidates, minConvertPriorityOf)) {
      const ids = group.map((candidate) => candidate.id);
      for (const id of await itemsWithLiveJobs(reader, bossSchema, queues, ids, minConvertPriority)) withJobs.add(id);
    }
    return withJobs;
  });
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

  /**
   * Step 2: ready videos whose conversion is `queued` with no job, on demand if anyone asked, else
   * the backlog. One that someone asked for needs an on-demand job: a backlog job waits while the
   * switch is off, so it doesn't count, and an on-demand one is sent beside it (the second of the
   * two to run does nothing).
   */
  async function requeueConversions(): Promise<{ requeued: number; recovered: number }> {
    const onDemandPriority = (item: ConversionCandidate) => (item.onDemand ? CONVERT_PRIORITY.onDemand : undefined);
    const stuck = await stuckAmong<ConversionCandidate>(
      bossSchema,
      CONVERSION_QUEUES,
      (reader) => queuedConversionsQuery(CANDIDATE_BATCH_SIZE, reader),
      onDemandPriority,
    );
    const stranded = await stuckAmong<ConversionCandidate>(
      bossSchema,
      CONVERSION_QUEUES,
      (reader) => convertingConversionsQuery(CANDIDATE_BATCH_SIZE, reader),
      onDemandPriority,
    );
    const recovered = await recoverConversions(stranded);
    const toSend = [...stuck, ...recovered];
    if (toSend.length > 0) {
      await boss.insert(
        MEDIA_QUEUES.convert,
        toSend.map((item) => ({
          data: { mediaId: item.id },
          priority: item.onDemand ? CONVERT_PRIORITY.onDemand : CONVERT_PRIORITY.backlog,
        })),
      );
    }
    return { requeued: toSend.length, recovered: recovered.length };
  }

  /**
   * Puts conversions left `converting` that no job will carry on back to `queued`, their lease
   * given up (Ruling AQ), and returns those it did. One statement, which leaves alone any whose
   * job has started running since the snapshot read them: that job is carrying it on.
   */
  async function recoverConversions(stranded: ConversionCandidate[]): Promise<ConversionCandidate[]> {
    if (stranded.length === 0) return [];
    const rows = await getDb().execute<{ id: string }>(sql`update ${media} set conversion = 'queued', conversion_job_id = null
      where ${inArray(sql`${media}.id`, stranded.map((item) => item.id))}
        and ${media}.conversion = 'converting'
        and not exists (select 1 from ${sql.identifier(bossSchema)}.job as job
          where job.name = ${MEDIA_QUEUES.convert} and job.state = 'active' and job.data ->> 'mediaId' = ${media}.id::text)
      returning ${media}.id as "id"`);
    const recovered = new Set(rows.map((row) => row.id));
    for (const item of stranded) {
      if (recovered.has(item.id)) console.log(`[worker] sweeper recovered conversion ${item.id}: converting, with no job to carry it on`);
    }
    return stranded.filter((item) => recovered.has(item.id));
  }

  /**
   * Step 4: hidden or deleted items still naming public files, and items with a withdrawal under
   * way, with no visibility job (or a dead letter on its way), each sent media.visibility `hide`.
   */
  async function requeueWithdrawals(): Promise<number> {
    const stuck = await stuckAmong(bossSchema, WITHDRAWAL_QUEUES, (reader) => withdrawalsQuery(CANDIDATE_BATCH_SIZE, reader));
    if (stuck.length > 0) {
      await boss.insert(
        MEDIA_QUEUES.visibility,
        stuck.map((item) => ({ data: { mediaId: item.id, action: "hide" } })),
      );
    }
    return stuck.length;
  }

  /**
   * Step 5: ready videos with no playable copy whose copy's job was never sent (in any state), each
   * sent media.playable once; one whose job ran, however it ended, is left as it is.
   */
  async function requeueCopies(): Promise<number> {
    const neverSent = await amongWithoutJobs(
      (reader) => missingCopiesQuery(CANDIDATE_BATCH_SIZE, reader),
      async (reader, candidates) => {
        const ids = candidates.map((candidate) => candidate.id);
        const rows = await reader.execute<{ mediaId: string; generation: string | null }>(copyJobsQuery(bossSchema, ids));
        const generationOf = new Map(candidates.map((candidate) => [candidate.id, String(candidate.generation)]));
        // A job counts for its own generation, or, naming none, for every one.
        return new Set(
          rows.filter((row) => row.generation === null || row.generation === generationOf.get(row.mediaId)).map((row) => row.mediaId),
        );
      },
    );
    if (neverSent.length > 0) {
      await boss.insert(
        MEDIA_QUEUES.playable,
        neverSent.map((item) => ({ data: { mediaId: item.id, generation: item.generation } satisfies PlayableJobData })),
      );
      for (const item of neverSent) console.log(`[worker] sweeper sent the playable copy's job of ${item.id}, which was never sent`);
    }
    return neverSent.length;
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

  /** One sweep: the five steps, each on its own, so one failing doesn't stop the others. */
  async function sweep(): Promise<SweepResult> {
    const result: SweepResult = {
      requeuedUploads: 0,
      requeuedConversions: 0,
      recoveredConversions: 0,
      checkedUploads: 0,
      rescuedUploads: 0,
      requeuedWithdrawals: 0,
      requeuedCopies: 0,
    };
    try {
      result.requeuedUploads = await requeueUploads();
    } catch (error) {
      console.error("[worker] sweeper could not queue stuck uploads:", describeError(error));
    }
    try {
      const conversions = await requeueConversions();
      result.requeuedConversions = conversions.requeued;
      result.recoveredConversions = conversions.recovered;
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
    try {
      result.requeuedWithdrawals = await requeueWithdrawals();
    } catch (error) {
      console.error("[worker] sweeper could not queue hidden items' withdrawals:", describeError(error));
    }
    try {
      result.requeuedCopies = await requeueCopies();
    } catch (error) {
      console.error("[worker] sweeper could not queue videos' playable copies:", describeError(error));
    }
    const queuedAnything =
      result.requeuedUploads > 0 || result.requeuedConversions > 0 || result.rescuedUploads > 0 || result.requeuedWithdrawals > 0;
    if (queuedAnything || result.requeuedCopies > 0) {
      console.log(
        `[worker] sweep queued ${result.requeuedUploads} upload(s), ${result.requeuedConversions} conversion(s), ${result.requeuedWithdrawals} withdrawal(s) and ${result.requeuedCopies} playable copy(ies), and finished ${result.rescuedUploads} of ${result.checkedUploads} unfinished upload(s)`,
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
