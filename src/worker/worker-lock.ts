import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import { describeError } from "@/lib/log-error";

/*
 * Ruling AZ: one worker at a time, whatever the deploy does. Each start removes the scratch folders
 * it finds and runs its own sweeper, so two containers running at once (a start-first deploy, which
 * Dokploy's Swarm form can quietly bring back) could remove a running job's files or queue an item
 * twice. Before either, the worker takes a Postgres session advisory lock on a fixed key, on a
 * connection of its own that stays open while it runs; a second worker waits for it, looking again
 * every 5 s. Postgres lets it go when that session ends: the worker stopping (its release), its
 * process dying (the kernel closes the socket), or its box vanishing (the keepalives below).
 */

/** How often a worker waiting for the lock tries again. */
export const WORKER_LOCK_POLL_MILLISECONDS = 5_000;
/** The lock's key: one per database, so the e2e and dev workers' databases never share it. */
const LOCK_NAME = "nona-worker";

/**
 * The lock's connection: one, never closed while the worker runs. postgres.js would otherwise
 * close it after 30 to 60 minutes (max_lifetime) and open another, without the lock. Every other
 * bound holds: 5 s to connect, 10 s a statement. On the server's side, no idle-session timeout
 * ends it, and TCP keepalives every 10 s after 30 s quiet, three missed, let Postgres notice within
 * about a minute that a worker's box has gone (no FIN), rather than its default of over two hours.
 */
export const LOCK_CONNECTION_OPTIONS = {
  max: 1,
  idle_timeout: null,
  max_lifetime: null,
  connect_timeout: 5,
  connection: {
    application_name: "nona-worker-lock",
    statement_timeout: 10_000,
    idle_session_timeout: 0,
    tcp_keepalives_idle: 30,
    tcp_keepalives_interval: 10,
    tcp_keepalives_count: 3,
  },
  onnotice: () => {},
} as const;

export type WorkerLock = {
  /** Resolves once the lock's connection has closed, and with it the lock: the worker must stop. */
  lost: Promise<void>;
  /** Whether this worker's session still holds the lock (false once its connection is gone). */
  isHeld(): Promise<boolean>;
  /** Lets the lock go, by ending its session. */
  release(): Promise<void>;
};

export type WorkerLockOptions = {
  /** Ends the wait early (the worker stopping): it rejects with the signal's reason. */
  signal?: AbortSignal;
  pollMilliseconds?: number;
};

/**
 * Resolves once this worker holds the worker lock, trying every 5 s while another worker holds
 * it, and saying once that it waits ("waiting for the previous worker to stop"). A database it
 * can't reach yet is waited for the same way.
 */
export async function takeWorkerLock(options: WorkerLockOptions = {}): Promise<WorkerLock> {
  const pollMilliseconds = options.pollMilliseconds ?? WORKER_LOCK_POLL_MILLISECONDS;
  let holding = false;
  let gone = false;
  let resolveLost = () => {};
  const lost = new Promise<void>((resolve) => (resolveLost = resolve));
  const sql = postgres({
    ...dbConfig(),
    ...LOCK_CONNECTION_OPTIONS,
    // Once it holds the lock, its connection closing is the lock gone; before, a failed try.
    onclose: () => {
      if (!holding) return;
      gone = true;
      resolveLost();
    },
  });
  let lastReported = "";
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      let waitingFor: string;
      try {
        const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${LOCK_NAME})) as locked`;
        if (row?.locked) {
          holding = true;
          if (lastReported) console.log("[worker] the previous worker has stopped: this one holds the worker lock");
          break;
        }
        waitingFor = "the previous worker to stop";
      } catch (error) {
        waitingFor = `the database, to take the worker lock (${describeError(error)})`;
      }
      if (waitingFor !== lastReported) {
        console.log(`[worker] waiting for ${waitingFor}; trying again every ${pollMilliseconds / 1000} s`);
        lastReported = waitingFor;
      }
      await delay(pollMilliseconds, undefined, { signal: options.signal });
    }
  } catch (error) {
    await sql.end({ timeout: 5 }).catch(() => {});
    throw options.signal?.aborted ? options.signal.reason : error;
  }

  let released = false;
  return {
    lost,
    async isHeld() {
      if (released || gone) return false;
      try {
        const [row] = await sql<{ held: boolean }[]>`select exists (select 1 from pg_locks
          where locktype = 'advisory' and granted and pid = pg_backend_pid()) as held`;
        return row?.held === true;
      } catch {
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      holding = false;
      await sql.end({ timeout: 5 });
    },
  };
}
