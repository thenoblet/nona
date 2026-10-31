import { spawn } from "node:child_process";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbConfig } from "@/lib/env";
import { LOCK_CONNECTION_OPTIONS, takeWorkerLock, WORKER_LOCK_KEYS, WORKER_LOCK_POLL_MILLISECONDS, type WorkerLock } from "./worker-lock";

/*
 * Ruling AZ: two worker containers overlapping (a start-first deploy) never both wipe scratch or
 * sweep. Against the test database: the lock is a Postgres session advisory lock, so these take it
 * as two workers would, each on a connection of its own.
 */

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const [FIRST_KEY, SECOND_KEY] = WORKER_LOCK_KEYS;
const held: WorkerLock[] = [];
const relays: { server: Server; sockets: Socket[] }[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(held.splice(0).map((lock) => lock.release()));
  for (const { server, sockets } of relays.splice(0)) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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

/** Polls until `check` passes or `timeoutMilliseconds` runs out, then runs it once more to report. */
async function eventually(check: () => Promise<void>, timeoutMilliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
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

/** The lock's sessions open in Postgres now. */
async function lockSessions(): Promise<number> {
  const [row] = await onOwnConnection(
    (sql) => sql<{ count: string }[]>`select count(*) from pg_stat_activity where application_name = 'nona-worker-lock'`,
  );
  return Number(row.count);
}

/**
 * A TCP relay to the test database whose client side can be cut on its own, as a network fault
 * cuts a worker off: Postgres keeps the session (and its lock) until it notices.
 */
async function relayToDatabase(): Promise<{ port: number; cutClients(): void }> {
  const database = dbConfig();
  const pairs: { client: Socket; upstream: Socket }[] = [];
  const sockets: Socket[] = [];
  const server = createServer((client) => {
    const upstream = connect(database.port, database.host);
    client.on("error", () => {});
    upstream.on("error", () => {});
    client.pipe(upstream);
    upstream.pipe(client);
    pairs.push({ client, upstream });
    sockets.push(client, upstream);
  });
  relays.push({ server, sockets });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    cutClients() {
      for (const { client, upstream } of pairs.splice(0)) {
        upstream.unpipe(client);
        client.unpipe(upstream);
        // The worker's side closes; Postgres's stays open and quiet, its session alive.
        client.destroy();
      }
    },
  };
}

describe("the worker lock (Ruling AZ)", () => {
  it("polls every 5 s in production, on a key space of its own (two int4 keys)", () => {
    expect(WORKER_LOCK_POLL_MILLISECONDS).toBe(5_000);
    expect(WORKER_LOCK_KEYS).toEqual([0x4e4f4e41, 0x57524b52]);
  });

  it("never collides with a single-key lock, such as the app's on a hashtext(...)", async () => {
    await take();
    const [other] = await onOwnConnection(
      (sql) => sql<{ single: boolean; same: boolean }[]>`select pg_try_advisory_lock(hashtext('nona-worker')) as single,
        pg_try_advisory_lock(${FIRST_KEY}::integer, ${SECOND_KEY}::integer) as same`,
    );
    expect(other).toEqual({ single: true, same: false });
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
         const [row] = await sql\`select pg_try_advisory_lock(${FIRST_KEY}, ${SECOND_KEY}) as locked\`;
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

  it("takes the lock again on a new connection when Postgres ends its session (a restart), and carries on: it isn't lost", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lock = await take();

    await onOwnConnection(
      (sql) => sql`select pg_terminate_backend(pid, 5000) from pg_stat_activity where application_name = 'nona-worker-lock'`,
    );

    await eventually(async () => expect(await lock.isHeld()).toBe(true));
    expect(await settledWithin(lock.lost, 500)).toBe(false);
    expect(errors.mock.calls.flat().join(" ")).toContain("the worker lock's connection closed; taking the lock again");
    // Still this worker's: another can't take it.
    const [other] = await onOwnConnection(
      (sql) => sql<{ locked: boolean }[]>`select pg_try_advisory_lock(${FIRST_KEY}::integer, ${SECOND_KEY}::integer) as locked`,
    );
    expect(other.locked).toBe(false);
    expect(await lockSessions()).toBe(1);
  });

  it("takes the lock again after a network cut, ending its own cut-off session that Postgres still thinks alive", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const relay = await relayToDatabase();
    const lock = await take({ database: { ...dbConfig(), host: "127.0.0.1", port: relay.port } });
    const [before] = await onOwnConnection(
      (sql) => sql<{ pid: number }[]>`select pid from pg_stat_activity where application_name = 'nona-worker-lock'`,
    );

    relay.cutClients();

    await eventually(async () => expect(await lock.isHeld()).toBe(true));
    expect(await settledWithin(lock.lost, 500)).toBe(false);
    // Its old session, which still held the lock, is gone; its new one holds it.
    const after = await onOwnConnection(
      (sql) => sql<{ pid: number }[]>`select pid from pg_stat_activity where application_name = 'nona-worker-lock'`,
    );
    expect(after).toHaveLength(1);
    expect(after[0].pid).not.toBe(before.pid);
  });

  it("is lost, so the worker stops, when another worker took the lock while its connection was down", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lock = await take();
    const rival = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
    try {
      // Another worker queues for the lock, so Postgres grants it the moment this worker's session ends.
      const rivalLocking = rival`select pg_advisory_lock(${FIRST_KEY}::integer, ${SECOND_KEY}::integer)`.execute();
      await new Promise((resolve) => setTimeout(resolve, 300));
      await onOwnConnection(
        (sql) => sql`select pg_terminate_backend(pid, 5000) from pg_stat_activity where application_name = 'nona-worker-lock'`,
      );
      await rivalLocking;

      await expect(Promise.race([lock.lost.then(() => "lost"), new Promise((resolve) => setTimeout(resolve, 5_000, "kept"))])).resolves.toBe(
        "lost",
      );
      expect(await lock.isHeld()).toBe(false);
      expect(errors.mock.calls.flat().join(" ")).toContain("another worker took the worker lock while its connection was down");
    } finally {
      await rival.end({ timeout: 5 });
    }
  });

  it("stops waiting when the worker is told to stop, leaving no connection behind", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await take();
    const stopping = new AbortController();

    const waiting = takeWorkerLock({ pollMilliseconds: 200, signal: stopping.signal });
    await new Promise((resolve) => setTimeout(resolve, 300));
    stopping.abort(new Error("The worker is stopping (SIGTERM)"));

    await expect(waiting).rejects.toThrow("The worker is stopping");
    // Only the holder's is open.
    await eventually(async () => expect(await lockSessions()).toBe(1));
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
