import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
