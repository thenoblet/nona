import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { buildWorker } from "../../scripts/build-worker.mjs";
import { resetDb } from "../../test/db";
import { dropBossSchema, startTestBoss } from "../../test/uploads";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
// Inside the project, so the bundle's packages resolve from its node_modules as the image's do.
const harnessFolder = join(projectRoot, "node_modules", ".cache", "nona-worker-harness");
const BOSS_SCHEMA = "pgboss_worker_runtime_test";

let boss: PgBoss;
let scratchRoot: string;

beforeAll(async () => {
  await resetDb();
  boss = await startTestBoss(BOSS_SCHEMA);
  scratchRoot = await mkdtemp(join(tmpdir(), "nona-worker-runtime-"));
  await buildWorker({ entryPoints: { "worker-harness": "test/worker-harness.ts" }, outdir: harnessFolder });
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
  await rm(scratchRoot, { recursive: true, force: true });
  await rm(harnessFolder, { recursive: true, force: true });
});

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every line the process prints to stdout, and a way to wait for the first that matches. */
function watchOutput(child: ChildProcess) {
  const lines: string[] = [];
  const waiters: { pattern: RegExp; resolve: (line: string) => void }[] = [];
  createInterface({ input: child.stdout! }).on("line", (line) => {
    lines.push(line);
    for (const waiter of waiters.filter((candidate) => candidate.pattern.test(line))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(line);
    }
  });
  return {
    lines,
    waitFor(pattern: RegExp, timeoutMilliseconds = 30_000): Promise<string> {
      const seen = lines.find((line) => pattern.test(line));
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`No line matched ${pattern} in ${timeoutMilliseconds} ms:\n${lines.join("\n")}`)),
          timeoutMilliseconds,
        );
        waiters.push({
          pattern,
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
        });
      });
    },
  };
}

/** Starts the harness as its own process, a worker as main.ts runs it, with its output watched. */
function startHarness(env: Record<string, string> = {}) {
  const harness = spawn(process.execPath, [join(harnessFolder, "worker-harness.mjs")], {
    env: { ...process.env, WORKER_SCRATCH_DIR: scratchRoot, HARNESS_QUEUE_SCHEMA: BOSS_SCHEMA, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  harness.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  const exited = new Promise<number | null>((resolve) => harness.on("exit", (exitCode) => resolve(exitCode)));
  return { harness, exited, output: watchOutput(harness), errors: () => errors };
}

describe("two workers overlapping, as a start-first deploy runs them (Ruling AZ)", () => {
  it("makes the second wait, its scratch and sweeper untouched, until the first stops, then take over within seconds", async () => {
    const first = startHarness();
    let second: ReturnType<typeof startHarness> | null = null;
    try {
      await first.output.waitFor(/\[worker\] ready/);
      // A job folder the first worker is using now: the second's start-up must not remove it.
      const running = join(scratchRoot, "job-running-in-the-first");
      await mkdir(running);
      await writeFile(join(running, "original"), "a guest's video");

      second = startHarness();
      await second.output.waitFor(/\[worker\] waiting for the previous worker to stop/);
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      expect(second.output.lines.join("\n")).not.toMatch(/ready|schema/);
      expect(await readdir(scratchRoot)).toContain("job-running-in-the-first");

      const stoppedAt = Date.now();
      first.harness.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      await second.output.waitFor(/\[worker\] ready/, 20_000);
      const tookOverIn = Date.now() - stoppedAt;
      console.log(`[Ruling AZ] the second worker was ready ${tookOverIn} ms after the first was told to stop`);

      // Within a poll (5 s) of the first's exit, and the start-up after it.
      expect(tookOverIn).toBeLessThan(15_000);
      // Its own start-up then cleared what the stopped worker left.
      expect(await readdir(scratchRoot)).not.toContain("job-running-in-the-first");
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\nThe first's stderr:\n${first.errors()}\nThe second's stderr:\n${second?.errors() ?? ""}`,
      );
    } finally {
      for (const worker of [first, second]) {
        if (worker && worker.harness.exitCode === null) {
          worker.harness.kill("SIGTERM");
          await worker.exited;
        }
      }
    }
  });
});

describe("the lock's connection closing under a running worker (Postgres restarting)", () => {
  it("takes the lock again and keeps the worker running, rather than kill every job", async () => {
    const worker = startHarness();
    try {
      await worker.output.waitFor(/\[worker\] ready/);
      const sql = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
      try {
        await sql`select pg_terminate_backend(pid, 5000) from pg_stat_activity where application_name = 'nona-worker-lock'`;
      } finally {
        await sql.end({ timeout: 5 });
      }

      await worker.output.waitFor(/\[worker\] took the worker lock again on a new connection/, 20_000);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(worker.harness.exitCode).toBeNull();
      expect(worker.errors()).toContain("the worker lock's connection closed; taking the lock again");
      expect(worker.output.lines.join("\n")).not.toContain("stopping");

      worker.harness.kill("SIGTERM");
      expect(await worker.exited).toBe(0);
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nThe worker's stderr:\n${worker.errors()}`);
    } finally {
      if (worker.harness.exitCode === null) {
        worker.harness.kill("SIGTERM");
        await worker.exited;
      }
    }
  });
});

describe("a scratch folder the worker can't use", () => {
  it("stops the worker with one plain line, never the raw EACCES and its stack", async () => {
    const locked = await mkdtemp(join(tmpdir(), "nona-worker-locked-"));
    const file = join(locked, "a-file");
    await writeFile(file, "not a folder");
    await chmod(locked, 0o555);
    try {
      // The mount missing (the folder can't be made), and a path that isn't a folder.
      for (const path of [join(locked, "scratch"), file]) {
        const { exited, output, errors } = startHarness({ WORKER_SCRATCH_DIR: path });
        expect(await exited, path).toBe(1);
        expect(errors().trim(), path).toBe(
          `[worker] can't use the scratch folder ${path}: mount /mnt/nona-worker at /scratch, writable by uid 10001`,
        );
        expect(output.lines, path).toEqual([]);
      }
    } finally {
      await chmod(locked, 0o755);
      await rm(locked, { recursive: true, force: true });
    }
  });
});

describe("the worker on SIGTERM", () => {
  it("kills a running ffmpeg and exits within 8 s, and the interrupted job goes back to its queue", async () => {
    const harness = spawn(process.execPath, [join(harnessFolder, "worker-harness.mjs")], {
      env: { ...process.env, WORKER_SCRATCH_DIR: scratchRoot, HARNESS_QUEUE_SCHEMA: BOSS_SCHEMA },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Its job's failure (ffmpeg killed) goes to stderr, kept to explain a failed test.
    let errors = "";
    harness.stderr?.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
    const exited = new Promise<number | null>((resolve) => harness.on("exit", (exitCode) => resolve(exitCode)));
    const output = watchOutput(harness);
    try {
      await output.waitFor(/\[worker\] ready/);
      const jobId = await boss.send(MEDIA_QUEUES.photo, { mediaId: randomUUID() });
      const [ffmpeg] = JSON.parse(await output.waitFor(/processIds/)).processIds as number[];
      expect(isRunning(ffmpeg)).toBe(true);

      const signalledAt = Date.now();
      harness.kill("SIGTERM");
      const exitCode = await exited;
      const stoppedIn = Date.now() - signalledAt;

      expect(stoppedIn).toBeLessThan(8_000);
      expect(exitCode).toBe(0);
      expect(isRunning(ffmpeg)).toBe(false);
      const [job] = await boss.findJobs(MEDIA_QUEUES.photo, { id: jobId ?? "" });
      expect(job.state).toBe("retry");
      expect(output.lines.join("\n")).toContain("[worker] stopped");
      expect(errors).toContain("ffmpeg was killed: stopping");
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : error}\nThe worker's stderr:\n${errors}`);
    } finally {
      if (harness.exitCode === null) harness.kill("SIGKILL");
    }
  });
});
