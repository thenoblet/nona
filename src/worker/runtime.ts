import type { PgBoss } from "pg-boss";
import { setSetting } from "@/lib/data/settings";
import { closeDb } from "@/lib/db/client";
import { dbConfig, storageConfig } from "@/lib/env";
import { createMediaQueues } from "@/lib/jobs/media-queues";
import { WORKER_HEARTBEAT_MILLISECONDS } from "@/lib/jobs/worker-heartbeat";
import { describeError, errorMessage } from "@/lib/log-error";
import type { WorkerConfig } from "./config";
import { stopAllProcesses } from "./processes";
import { startQueueWorkers, type MediaHandlers, type QueueWorkers } from "./queues";
import { waitForSchema } from "./schema-ready";
import { prepareScratchRoot } from "./scratch";
import { createSweeper, startSweeping } from "./sweeper";

/** Once stopping, how long running jobs get to settle before pg-boss fails them back to their queues. */
const STOP_GRACE_MILLISECONDS = 5_000;
/** The process exits this soon after SIGTERM whatever is left, inside Docker's 10 s before it kills. */
const EXIT_DEADLINE_MILLISECONDS = 8_000;

export type WorkerOptions = {
  config: WorkerConfig;
  handlers: MediaHandlers;
  /** The Drizzle journal and migrations the build copied beside the bundle. */
  migrationsFolder: string;
  /** Starts the job queue, once the schema is ready: getBoss with the worker's pool, in production. */
  startQueue: () => Promise<PgBoss>;
  /** The schema the job queue keeps its tables in, which the sweeper reads. */
  queueSchema: string;
};

/**
 * Runs the media worker until SIGTERM or SIGINT. In order: checks its settings, clears what an
 * earlier run left in scratch, waits for the database schema it was built with, creates the media
 * queues (idempotent, as the app does too, so whichever starts first can send), starts every
 * queue's workers, then heartbeats every 30 s and sweeps every 10 minutes. Logs "ready" once jobs
 * are being taken. A failure on the way exits with 1, for the container to be restarted.
 *
 * On a signal it stops fetching, kills every running program at once, gives jobs 5 s to settle,
 * fails the rest back to their queues (as a missed heartbeat would) and exits, all within 8 s.
 */
export async function runWorker(options: WorkerOptions): Promise<void> {
  const stopping = new AbortController();
  let boss: PgBoss | null = null;
  let workers: QueueWorkers | null = null;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const stop = async (signalName: string) => {
    if (stopping.signal.aborted) return;
    console.log(`[worker] stopping (${signalName})`);
    setTimeout(() => {
      console.error("[worker] still stopping after 8 s; exiting");
      process.exit(1);
    }, EXIT_DEADLINE_MILLISECONDS).unref();
    stopping.abort(new Error(`The worker is stopping (${signalName})`));
    clearTimeout(heartbeatTimer);
    workers?.stopFetching();
    // Their jobs' handlers fail at once, and pg-boss puts the jobs back to be retried.
    stopAllProcesses();
    try {
      // Waits for the handlers still running, fails any left after the grace, and closes its pool.
      await boss?.stop({ graceful: true, timeout: STOP_GRACE_MILLISECONDS });
      await closeDb();
    } catch (error) {
      console.error("[worker] could not stop cleanly:", errorMessage(error));
      process.exit(1);
    }
    console.log("[worker] stopped");
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  const beat = async () => {
    try {
      await setSetting("worker_heartbeat", new Date().toISOString());
      await workers?.followBacklogSwitch();
    } catch (error) {
      console.error("[worker] heartbeat failed:", describeError(error));
    }
    if (!stopping.signal.aborted) heartbeatTimer = setTimeout(beat, WORKER_HEARTBEAT_MILLISECONDS);
  };

  try {
    // Named at once if missing, rather than as a wait that never ends.
    dbConfig();
    storageConfig();
    await prepareScratchRoot(options.config.scratchRoot);
    await waitForSchema({ migrationsFolder: options.migrationsFolder, signal: stopping.signal });
    boss = await options.startQueue();
    await createMediaQueues(boss);
    workers = await startQueueWorkers(boss, options.handlers, options.config.concurrency);
    await beat();
    startSweeping(createSweeper({ boss, bossSchema: options.queueSchema, signal: stopping.signal }), stopping.signal);
    console.log("[worker] ready: taking media jobs");
  } catch (error) {
    // A signal during start-up: stop() is already exiting.
    if (stopping.signal.aborted) return;
    console.error("[worker] could not start:", errorMessage(error));
    process.exit(1);
  }
}
