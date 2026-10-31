import type { Job, JobResult, JobWithMetadata, PgBoss, WorkOptions } from "pg-boss";
import { isUuid } from "@/lib/data/ids";
import { getSetting, SETTING_DEFAULTS } from "@/lib/data/settings";
import { CONVERT_PRIORITY, MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { describeError, errorMessage } from "@/lib/log-error";
import { markConversionFailed, markProcessingFailed } from "@/lib/media/rows";
import type { WorkerConcurrency } from "./config";

/*
 * The worker's queues, each taken by its own pg-boss workers at its own concurrency: a long
 * conversion never holds up a photo, which stays fast because conversions run nice'd with capped
 * threads. Each job runs through runJobs, which logs its duration and settles it:
 * - completed;
 * - a PermanentJobError (a corrupt or unsupported file) goes straight to media.dead, no retries;
 * - any other error retries with backoff (media-queues.ts), and goes to media.dead when they run out.
 * media.dead's handler then marks the item failed, with the reason its uploader is shown.
 */

/** The queues the worker takes jobs from, media.dead apart. */
export type WorkQueueName = Exclude<MediaQueueName, typeof MEDIA_QUEUES.dead>;

/** A job as its handler sees it. Its data holds ids only, never a guest's name or a filename. */
export type MediaJob = {
  id: string;
  queue: WorkQueueName;
  data: Record<string, unknown>;
  /**
   * Aborted when the job expires (15 minutes, a conversion 4 hours) or the worker stops. Pass it to
   * every stream (readOriginalStream, putPublicObject, saveOriginal), program (runProcess) and R2
   * call (Ruling L), so nothing outlives its job.
   */
  signal: AbortSignal;
  retryCount: number;
};

/** What a handler tells the job's log line: the file's size and kind, never anything personal. */
export type JobReport = { sizeBytes?: number; kind?: string };

export type MediaJobHandler = (job: MediaJob) => Promise<JobReport | void>;

/**
 * Each queue's handler; media.convert's serves both its on-demand and its backlog workers. A queue
 * with none yet (its task hasn't shipped) gets no workers: its jobs wait in the queue, unfailed,
 * for the release that brings its handler (Ruling AA).
 */
export type MediaHandlers = Partial<Record<WorkQueueName, MediaJobHandler>>;

/** A short reason an uploader is shown, which the album turns into plain words. */
const FAILURE_REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The reason for a job that failed every retry. */
const RETRIES_USED_UP = "processing-failed";

/**
 * A failure retrying can't fix: the file is corrupt or of a type the album doesn't take. The job
 * goes to media.dead at once, and its item is marked failed with `reason` ("corrupt",
 * "unsupported-type"), which its uploader sees. Its message goes to the log: ids and facts about
 * the file only, never a guest's name or the file's.
 */
export class PermanentJobError extends Error {
  override name = "PermanentJobError";
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** The item a job is about, when its data names one. */
function mediaIdOf(data: unknown): string | null {
  const mediaId = (data as { mediaId?: unknown } | null)?.mediaId;
  return typeof mediaId === "string" && isUuid(mediaId) ? mediaId : null;
}

function describeReport(report: JobReport | void): string {
  if (!report) return "";
  const size = report.sizeBytes === undefined ? "" : ` size=${report.sizeBytes}`;
  const kind = report.kind === undefined ? "" : ` kind=${report.kind}`;
  return `${size}${kind}`;
}

/**
 * A check a worker makes before each job it fetched: the backlog conversions' switch. A job it
 * doesn't allow is held back: waiting on its queue again, never failed, its attempts not used.
 */
type JobGate = {
  allows(): Promise<boolean>;
  /** Puts the job back to wait. Never throws. */
  hold(job: Job<Record<string, unknown>>): Promise<void>;
  /** Why a job was held, for the log. */
  reason: string;
};

/** Runs a queue's jobs through its handler (once `gate`, if any, allows each), logging each one's duration, and settles each. */
function runJobs(queue: WorkQueueName, handler: MediaJobHandler, gate?: JobGate) {
  return (jobs: Job<Record<string, unknown>>[]): Promise<JobResult[]> =>
    Promise.all(
      jobs.map(async (job): Promise<JobResult> => {
        const startedAt = performance.now();
        const mediaId = mediaIdOf(job.data);
        const subject = `job=${job.id}${mediaId ? ` media=${mediaId}` : ""}`;
        const elapsed = () => Math.round(performance.now() - startedAt);
        try {
          if (gate && !(await gate.allows())) {
            await gate.hold(job);
            console.log(`[worker] ${queue} held back ${subject}: ${gate.reason}`);
            return { id: job.id, status: "completed", output: { held: gate.reason } };
          }
          const report = await handler({
            id: job.id,
            queue,
            data: job.data ?? {},
            signal: job.signal,
            retryCount: job.retryCount,
          });
          console.log(`[worker] ${queue} completed in ${elapsed()} ms ${subject}${describeReport(report)}`);
          return { id: job.id, status: "completed" };
        } catch (error) {
          if (error instanceof PermanentJobError) {
            console.error(`[worker] ${queue} failed for good in ${elapsed()} ms ${subject} reason=${error.reason}: ${error.message}`);
            return { id: job.id, status: "deadletter", output: { reason: error.reason, error: errorMessage(error) } };
          }
          console.error(
            `[worker] ${queue} failed in ${elapsed()} ms ${subject} on attempt ${job.retryCount + 1}: ${errorMessage(error)}`,
          );
          return { id: job.id, status: "failed", output: { error: errorMessage(error) } };
        }
      }),
    );
}

/** The reason a dead-lettered job's last failure gave, or "processing-failed" when it gave none. */
function failureReason(output: unknown): string {
  const reason = (output as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && FAILURE_REASON.test(reason) ? reason : RETRIES_USED_UP;
}

const PROCESSING_QUEUES = new Set<string>([MEDIA_QUEUES.photo, MEDIA_QUEUES.poster, MEDIA_QUEUES.wish]);

/**
 * media.dead's handler: a job that failed for good. Its item's processing (photo, poster, wish)
 * marks the item failed with the reason; a conversion marks only the conversion failed, since the
 * video keeps its poster. Anything else (a hide, a full-size JPEG, a card) leaves the item as it
 * is, and is logged for the couple's status page. A database error here retries, a minute apart.
 */
async function handleDeadLetters(jobs: JobWithMetadata<Record<string, unknown>>[]): Promise<void> {
  for (const job of jobs) {
    const source = job.sourceName ?? "an unknown queue";
    const mediaId = mediaIdOf(job.data);
    const reason = failureReason(job.sourceOutput);
    if (mediaId && PROCESSING_QUEUES.has(source)) {
      const marked = await markProcessingFailed(mediaId, reason);
      console.error(
        marked
          ? `[worker] ${source} job for ${mediaId} failed for good: marked failed (${reason})`
          : `[worker] ${source} job for ${mediaId} failed for good (${reason}): left as it was, ready or gone`,
      );
    } else if (mediaId && source === MEDIA_QUEUES.convert) {
      const marked = await markConversionFailed(mediaId);
      console.error(
        marked
          ? `[worker] ${source} job for ${mediaId} failed for good: conversion marked failed (${reason})`
          : `[worker] ${source} job for ${mediaId} failed for good (${reason}): left as it was, converted already or gone`,
      );
    } else {
      console.error(`[worker] ${source} job for ${mediaId ?? "no item"} failed for good: ${reason}`);
    }
  }
}

export type QueueWorkerOptions = {
  /** How often an idle worker looks for jobs: pg-boss's 2 s unless a test wants it quicker. */
  pollingIntervalSeconds?: number;
};

export type QueueWorkers = {
  /** Starts or stops the backlog conversions to match the admin's convert_backlog switch. */
  followBacklogSwitch(): Promise<void>;
  /** Stops every queue's workers fetching. Jobs already running carry on (or are killed by their signal). */
  stopFetching(): void;
};

/**
 * Starts the workers for every media queue that has a handler, each at its concurrency, and
 * media.dead's handler. A queue with no handler gets none, and is named once in the log.
 * media.convert has two: on-demand (priority 20 and up) always, and the backlog (below 20) while
 * the convert_backlog switch is on. While it is off, backlog jobs wait in the queue, unfailed:
 * the backlog worker is stopped within one heartbeat (30 s) of the switch going off, and reads the
 * switch again before each job it fetched, so one fetched just before is held back, not run.
 */
export async function startQueueWorkers(
  boss: PgBoss,
  handlers: MediaHandlers,
  concurrency: WorkerConcurrency,
  options: QueueWorkerOptions = {},
): Promise<QueueWorkers> {
  const polling: WorkOptions =
    options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds };

  const work = (
    queue: WorkQueueName,
    handler: MediaJobHandler,
    localConcurrency: number,
    priorities: WorkOptions = {},
    gate?: JobGate,
  ) =>
    boss.work<Record<string, unknown>, JobResult[], WorkOptions & { perJobResults: true }>(
      queue,
      { ...polling, ...priorities, localConcurrency, perJobResults: true },
      runJobs(queue, handler, gate),
    );

  const queues: [WorkQueueName, number][] = [
    [MEDIA_QUEUES.photo, concurrency.photo],
    [MEDIA_QUEUES.jpeg, concurrency.jpeg],
    [MEDIA_QUEUES.poster, concurrency.poster],
    [MEDIA_QUEUES.wish, concurrency.wish],
    [MEDIA_QUEUES.visibility, concurrency.visibility],
    [MEDIA_QUEUES.card, concurrency.card],
  ];
  for (const [queue, localConcurrency] of queues) {
    const handler = handlers[queue];
    if (handler) await work(queue, handler, localConcurrency);
  }
  const convert = handlers[MEDIA_QUEUES.convert];
  if (convert) {
    await work(MEDIA_QUEUES.convert, convert, concurrency.convertOnDemand, { minPriority: CONVERT_PRIORITY.onDemand });
  }
  const waiting = [...queues.map(([queue]) => queue), MEDIA_QUEUES.convert].filter((queue) => !handlers[queue]);
  if (waiting.length > 0) {
    console.log(`[worker] no handler yet for ${waiting.join(", ")}: their jobs wait in the queue`);
  }
  await boss.work<Record<string, unknown>, void, WorkOptions & { includeMetadata: true }>(
    MEDIA_QUEUES.dead,
    { ...polling, localConcurrency: 1, includeMetadata: true },
    handleDeadLetters,
  );

  let backlogWorkId: string | null = null;
  let stopped = false;
  // One change of the switch at a time, so two quick calls can't start the backlog twice.
  let following = Promise.resolve();

  const backlogSwitchOn = async () =>
    (await getSetting("convert_backlog", SETTING_DEFAULTS.convert_backlog)) === true;

  /**
   * The backlog worker's check before each job: the switch as it is now, not as the last heartbeat
   * saw it, so a job fetched in the moments after the switch went off is held back, not run. The
   * worker stops fetching first (so the job isn't taken again at once); then a copy of the job is
   * sent to wait in the backlog, and this attempt completes. A copy rather than the job put back:
   * pg-boss counts every fetch of a job that has started as an attempt, which would bring a held
   * file nearer to being blamed (from its third attempt) and its retries nearer their end. If the
   * copy can't be sent, the conversion's row is still `queued`, and the sweeper sends it again.
   */
  const backlogGate: JobGate = {
    allows: backlogSwitchOn,
    async hold(job) {
      // If this can't read the switch, the next heartbeat (within 30 s) stops the worker, and logs why.
      await followBacklogSwitch().catch(() => {});
      try {
        await boss.send(MEDIA_QUEUES.convert, job.data ?? {}, { priority: CONVERT_PRIORITY.backlog });
      } catch (error) {
        console.error(`[worker] could not put back held job=${job.id}; the sweeper will send it again:`, describeError(error));
      }
    },
    reason: "the backlog switch is off, so it waits in the queue",
  };

  const followSwitchNow = async () => {
    if (stopped || !convert) return;
    const backlogOn = await backlogSwitchOn();
    if (backlogOn && backlogWorkId === null) {
      backlogWorkId = await work(
        MEDIA_QUEUES.convert,
        convert,
        concurrency.convertBacklog,
        { maxPriority: CONVERT_PRIORITY.onDemand - 1 },
        backlogGate,
      );
      console.log("[worker] backlog conversions on");
    } else if (!backlogOn && backlogWorkId !== null) {
      // Stops fetching; a backlog conversion already running finishes.
      boss
        .offWork(MEDIA_QUEUES.convert, { id: backlogWorkId, wait: false })
        .catch((error) => console.error("[worker] could not stop the backlog conversions:", describeError(error)));
      backlogWorkId = null;
      console.log("[worker] backlog conversions paused by the switch");
    }
  };

  const followBacklogSwitch = () => {
    following = following.catch(() => {}).then(followSwitchNow);
    return following;
  };

  await followBacklogSwitch();

  return {
    followBacklogSwitch,
    stopFetching() {
      stopped = true;
      for (const queue of Object.values(MEDIA_QUEUES)) {
        boss
          .offWork(queue, { wait: false })
          .catch((error) => console.error(`[worker] could not stop ${queue}'s workers:`, describeError(error)));
      }
    },
  };
}
