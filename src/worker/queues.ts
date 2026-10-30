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

/** One handler for each queue; media.convert's serves both its on-demand and its backlog workers. */
export type MediaHandlers = Record<WorkQueueName, MediaJobHandler>;

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

/** The handler of a queue whose processing a later task adds: it fails the job for good, saying so. */
export const notImplementedYet: MediaJobHandler = async (job) => {
  throw new PermanentJobError("not-implemented", `${job.queue} has no handler yet`);
};

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

/** Runs a queue's jobs through its handler, logging each one's duration, and settles each. */
function runJobs(queue: WorkQueueName, handler: MediaJobHandler) {
  return (jobs: Job<Record<string, unknown>>[]): Promise<JobResult[]> =>
    Promise.all(
      jobs.map(async (job): Promise<JobResult> => {
        const startedAt = performance.now();
        const mediaId = mediaIdOf(job.data);
        const subject = `job=${job.id}${mediaId ? ` media=${mediaId}` : ""}`;
        const elapsed = () => Math.round(performance.now() - startedAt);
        try {
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
      await markProcessingFailed(mediaId, reason);
      console.error(`[worker] ${source} job for ${mediaId} failed for good: marked failed (${reason})`);
    } else if (mediaId && source === MEDIA_QUEUES.convert) {
      await markConversionFailed(mediaId);
      console.error(`[worker] ${source} job for ${mediaId} failed for good: conversion marked failed (${reason})`);
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
 * Starts the workers for every media queue, each at its concurrency, and media.dead's handler.
 * media.convert has two: on-demand (priority 20 and up) always, and the backlog (below 20) while
 * the convert_backlog switch is on. While it is off, backlog jobs wait in the queue, unfailed.
 */
export async function startQueueWorkers(
  boss: PgBoss,
  handlers: MediaHandlers,
  concurrency: WorkerConcurrency,
  options: QueueWorkerOptions = {},
): Promise<QueueWorkers> {
  const polling: WorkOptions =
    options.pollingIntervalSeconds === undefined ? {} : { pollingIntervalSeconds: options.pollingIntervalSeconds };

  const work = (queue: WorkQueueName, localConcurrency: number, priorities: WorkOptions = {}) =>
    boss.work<Record<string, unknown>, JobResult[], WorkOptions & { perJobResults: true }>(
      queue,
      { ...polling, ...priorities, localConcurrency, perJobResults: true },
      runJobs(queue, handlers[queue]),
    );

  await work(MEDIA_QUEUES.photo, concurrency.photo);
  await work(MEDIA_QUEUES.jpeg, concurrency.jpeg);
  await work(MEDIA_QUEUES.poster, concurrency.poster);
  await work(MEDIA_QUEUES.wish, concurrency.wish);
  await work(MEDIA_QUEUES.visibility, concurrency.visibility);
  await work(MEDIA_QUEUES.card, concurrency.card);
  await work(MEDIA_QUEUES.convert, concurrency.convertOnDemand, { minPriority: CONVERT_PRIORITY.onDemand });
  await boss.work<Record<string, unknown>, void, WorkOptions & { includeMetadata: true }>(
    MEDIA_QUEUES.dead,
    { ...polling, localConcurrency: 1, includeMetadata: true },
    handleDeadLetters,
  );

  let backlogWorkId: string | null = null;
  let stopped = false;
  // One change of the switch at a time, so two quick calls can't start the backlog twice.
  let following = Promise.resolve();

  const followSwitchNow = async () => {
    if (stopped) return;
    const backlogOn = (await getSetting("convert_backlog", SETTING_DEFAULTS.convert_backlog)) === true;
    if (backlogOn && backlogWorkId === null) {
      backlogWorkId = await work(MEDIA_QUEUES.convert, concurrency.convertBacklog, {
        maxPriority: CONVERT_PRIORITY.onDemand - 1,
      });
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
