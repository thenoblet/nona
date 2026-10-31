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
 *
 * The lock's connection can also close under a running worker: Postgres restarting, or the network
 * cutting it. Then the worker takes the lock again on a fresh connection, trying every 5 s while
 * the database can't be reached, and carries on. After a cut, the old session may still hold the
 * lock until Postgres notices it is gone: being the worker's own (its backend's pid), it is ended
 * (pg_terminate_backend, which a role may do to its own sessions) and the lock taken. Only if
 * another worker holds it by then is the lock lost, and the worker stops. So a Postgres restart, or
 * a network blip, never kills the conversions running.
 */

/** How often a worker waiting for the lock (or to take it again) tries. */
export const WORKER_LOCK_POLL_MILLISECONDS = 5_000;
/**
 * The lock's key, in Postgres's two-key form (two int4s: "NONA", "WRKR" in ASCII), a key space of
 * its own: no single-key lock, such as one on a hashtext(...), can ever be the same lock.
 */
export const WORKER_LOCK_KEYS = [0x4e4f4e41, 0x57524b52] as const;

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
  /** Resolves once the lock is lost: its connection closed and another worker holds it now. The worker must stop. */
  lost: Promise<void>;
  /** Whether this worker's session holds the lock now (false while it takes it again, or once released). */
  isHeld(): Promise<boolean>;
  /** Lets the lock go, by ending its session, and stops taking it again. */
  release(): Promise<void>;
};

export type WorkerLockOptions = {
  /** Ends the wait early (the worker stopping): it rejects with the signal's reason. */
  signal?: AbortSignal;
  pollMilliseconds?: number;
  /** Where the database is: dbConfig()'s, unless a test reaches it another way. */
  database?: ReturnType<typeof dbConfig>;
};

/** What trying for the lock found: whether this session holds it, and the session's backend pid. */
type LockTry = { locked: boolean; backendPid: number };

/** Tries to take the lock on this connection's session. Throws when the database can't be reached. */
async function tryLock(sql: postgres.Sql): Promise<LockTry> {
  const [first, second] = WORKER_LOCK_KEYS;
  const [row] = await sql<{ locked: boolean; backendPid: number }[]>`select
    pg_try_advisory_lock(${first}::integer, ${second}::integer) as locked, pg_backend_pid() as "backendPid"`;
  return { locked: row?.locked === true, backendPid: Number(row?.backendPid) };
}

/** The backend pid of the session holding the lock, or null when none does. */
async function holderOf(sql: postgres.Sql): Promise<number | null> {
  const [first, second] = WORKER_LOCK_KEYS;
  // The two-key form: classid and objid are the keys, objsubid 2.
  const [row] = await sql<{ pid: number }[]>`select pid from pg_locks
    where locktype = 'advisory' and granted
      and classid = ${first}::integer::oid and objid = ${second}::integer::oid and objsubid = 2`;
  return row ? Number(row.pid) : null;
}

/**
 * Resolves once this worker holds the worker lock, trying every 5 s while another worker holds
 * it, and saying once that it waits ("waiting for the previous worker to stop"). A database it
 * can't reach yet is waited for the same way.
 */
export async function takeWorkerLock(options: WorkerLockOptions = {}): Promise<WorkerLock> {
  const pollMilliseconds = options.pollMilliseconds ?? WORKER_LOCK_POLL_MILLISECONDS;
  const database = options.database ?? dbConfig();
  let current: postgres.Sql | null = null;
  /** The backend pid of the session that holds the lock for this worker, to know it after a cut. */
  let heldByBackend: number | null = null;
  let released = false;
  let resolveLost = () => {};
  const lost = new Promise<void>((resolve) => (resolveLost = resolve));

  /** Opens a lock connection, which takes the lock again should it close while it holds it. */
  const open = (): postgres.Sql => {
    const sql = postgres({ ...database, ...LOCK_CONNECTION_OPTIONS, onclose: () => onClosed(sql) });
    return sql;
  };
  /** A lock connection closed: if it held the lock, the lock is taken again on a fresh one. */
  const onClosed = (sql: postgres.Sql) => {
    if (current !== sql || released) return;
    current = null;
    void sql.end({ timeout: 0 }).catch(() => {});
    console.error("[worker] the worker lock's connection closed; taking the lock again");
    void takeAgain();
  };

  /** After the lock's connection closed: on a fresh one, until it holds the lock, finds another worker holding it, or is released. */
  const takeAgain = async (): Promise<void> => {
    let reported = false;
    while (!released) {
      const sql = open();
      try {
        const attempt = await tryLock(sql);
        if (attempt.locked) {
          if (released) {
            await sql.end({ timeout: 5 }).catch(() => {});
            return;
          }
          current = sql;
          heldByBackend = attempt.backendPid;
          console.log("[worker] took the worker lock again on a new connection");
          return;
        }
        const holder = await holderOf(sql);
        if (holder !== null && holder === heldByBackend) {
          // This worker's own session, cut off, which Postgres hasn't noticed yet: ended, then tried again at once.
          await sql`select pg_terminate_backend(${holder}::integer, 5000)`;
          await sql.end({ timeout: 5 }).catch(() => {});
          continue;
        }
        if (holder === null) {
          // Let go between the two reads: tried again at once.
          await sql.end({ timeout: 5 }).catch(() => {});
          continue;
        }
        await sql.end({ timeout: 5 }).catch(() => {});
        console.error("[worker] another worker took the worker lock while its connection was down");
        resolveLost();
        return;
      } catch (error) {
        await sql.end({ timeout: 0 }).catch(() => {});
        if (!reported) {
          console.error(`[worker] can't take the worker lock again yet (${describeError(error)}); trying every ${pollMilliseconds / 1000} s`);
          reported = true;
        }
      }
      await delay(pollMilliseconds, undefined, { ref: false });
    }
  };

  let lastReported = "";
  for (;;) {
    const sql = open();
    try {
      options.signal?.throwIfAborted();
      let waitingFor: string;
      try {
        const attempt = await tryLock(sql);
        if (attempt.locked) {
          current = sql;
          heldByBackend = attempt.backendPid;
          if (lastReported) console.log("[worker] the previous worker has stopped: this one holds the worker lock");
          break;
        }
        waitingFor = "the previous worker to stop";
      } catch (error) {
        waitingFor = `the database, to take the worker lock (${describeError(error)})`;
      }
      await sql.end({ timeout: 5 }).catch(() => {});
      if (waitingFor !== lastReported) {
        console.log(`[worker] waiting for ${waitingFor}; trying again every ${pollMilliseconds / 1000} s`);
        lastReported = waitingFor;
      }
      await delay(pollMilliseconds, undefined, { signal: options.signal });
    } catch (error) {
      await sql.end({ timeout: 5 }).catch(() => {});
      throw options.signal?.aborted ? options.signal.reason : error;
    }
  }

  return {
    lost,
    async isHeld() {
      const sql = current;
      if (released || sql === null) return false;
      try {
        const [row] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
        return (await holderOf(sql)) === Number(row?.pid);
      } catch {
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      const sql = current;
      current = null;
      await sql?.end({ timeout: 5 });
    },
  };
}
