import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbConfig } from "@/lib/env";
import { LOCK_CONNECTION_OPTIONS, takeWorkerLock, WORKER_LOCK_POLL_MILLISECONDS, type WorkerLock } from "./worker-lock";

/*
 * Ruling AZ: two worker containers overlapping (a start-first deploy) never both wipe scratch or
 * sweep. Against the test database: the lock is a Postgres session advisory lock, so these take it
 * as two workers would, each on a connection of its own.
 */

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const held: WorkerLock[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(held.splice(0).map((lock) => lock.release()));
});

async function take(options: Parameters<typeof takeWorkerLock>[0] = {}): Promise<WorkerLock> {
  const lock = await takeWorkerLock({ pollMilliseconds: 200, ...options });
  held.push(lock);
  return lock;
}

/** Whether the promise has settled after `milliseconds`. */
async function settledWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return settled;
}

/** Runs a query on a connection of the test's own. */
async function onOwnConnection<TResult>(query: (sql: postgres.Sql) => Promise<TResult>): Promise<TResult> {
  const sql = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    return await query(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

describe("the worker lock (Ruling AZ)", () => {
  it("polls every 5 s in production", () => {
    expect(WORKER_LOCK_POLL_MILLISECONDS).toBe(5_000);
  });

  it("makes a second worker wait, saying so, and hands over within a poll of the first letting go", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const first = await take();

    const secondTaking = take();
    expect(await settledWithin(secondTaking, 1_000)).toBe(false);
    expect(log.mock.calls.flat().join("\n")).toContain("[worker] waiting for the previous worker to stop");

    const releasedAt = performance.now();
    await first.release();
    const second = await secondTaking;
    expect(performance.now() - releasedAt).toBeLessThan(2_000);
    expect(await second.isHeld()).toBe(true);
    // Said once while it waited, not on every poll.
    expect(log.mock.calls.filter((call) => String(call[0]).includes("waiting for the previous worker")).length).toBe(1);
  });

  it("is let go when the worker holding it dies, with no release: Postgres ends its session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Another process takes the lock as the worker does, then is killed outright (SIGKILL).
    const holder = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import postgres from "postgres";
         const sql = postgres({ host: process.env.POSTGRES_HOST, port: Number(process.env.POSTGRES_PORT), database: process.env.POSTGRES_DB,
           username: process.env.POSTGRES_USER, password: process.env.POSTGRES_PASSWORD, max: 1, onnotice: () => {} });
         const [row] = await sql\`select pg_try_advisory_lock(hashtext('nona-worker')) as locked\`;
         console.log(row.locked ? "locked" : "refused");`,
      ],
      { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      const firstLine = await new Promise<string>((resolve) => createInterface({ input: holder.stdout! }).once("line", resolve));
      expect(firstLine).toBe("locked");

      const taking = take();
      expect(await settledWithin(taking, 600)).toBe(false);
      holder.kill("SIGKILL");

      const lock = await taking;
      expect(await lock.isHeld()).toBe(true);
    } finally {
      if (holder.exitCode === null) holder.kill("SIGKILL");
    }
  });

  it("says it is lost once its connection is gone, so the worker stops rather than run beside another", async () => {
    const lock = await take();
    expect(await lock.isHeld()).toBe(true);

    // Postgres restarting, or the network cutting the session: its advisory lock goes with it.
    await onOwnConnection(
      (sql) => sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'nona-worker-lock'`,
    );

    await expect(Promise.race([lock.lost.then(() => "lost"), new Promise((resolve) => setTimeout(resolve, 5_000, "kept"))])).resolves.toBe(
      "lost",
    );
    expect(await lock.isHeld()).toBe(false);
    // Another worker may now take it.
    const next = await take();
    expect(await next.isHeld()).toBe(true);
  });

  it("stops waiting when the worker is told to stop", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await take();
    const stopping = new AbortController();

    const waiting = takeWorkerLock({ pollMilliseconds: 200, signal: stopping.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    stopping.abort(new Error("The worker is stopping (SIGTERM)"));

    await expect(waiting).rejects.toThrow("The worker is stopping");
    // It left no connection behind: only the holder's is open.
    const sessions = await onOwnConnection(
      (sql) => sql<{ count: string }[]>`select count(*) from pg_stat_activity where application_name = 'nona-worker-lock'`,
    );
    expect(Number(sessions[0].count)).toBe(1);
  });

  it("keeps its session open for good: no idle timeout, no connection lifetime, and keepalives Postgres notices a vanished box by", () => {
    expect(LOCK_CONNECTION_OPTIONS).toMatchObject({ max: 1, idle_timeout: null, max_lifetime: null, connect_timeout: 5 });
    expect(LOCK_CONNECTION_OPTIONS.connection).toMatchObject({
      application_name: "nona-worker-lock",
      statement_timeout: 10_000,
      idle_session_timeout: 0,
      // Postgres notices a worker box that vanished (no FIN) within about a minute, not its default two hours.
      tcp_keepalives_idle: 30,
      tcp_keepalives_interval: 10,
      tcp_keepalives_count: 3,
    });
  });
});
