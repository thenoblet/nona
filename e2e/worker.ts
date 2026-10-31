import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "../test/env";

/*
 * The media worker for the e2e run: its production image (Dockerfile.worker's `run` target, the
 * one Dokploy runs, with ffmpeg 7 and libheif), on the host's network against the test database
 * and MinIO, as the worker CI job runs its tests. CI builds the image just before, with its layer
 * cache, and names it in E2E_WORKER_IMAGE; locally it is built here (Docker's own cache makes a
 * rebuild after a code change take seconds), so the e2e never runs an old worker.
 */

const execute = promisify(execFile);

const CONTAINER = "nona-e2e-worker";
const LOCAL_IMAGE = "nona-worker-e2e";
const READY_TIMEOUT_MILLISECONDS = 90_000;

function docker(args: string[], timeoutMilliseconds = 60_000) {
  return execute("docker", args, { timeout: timeoutMilliseconds, maxBuffer: 16 * 1024 * 1024 });
}

/** Builds the worker's production image from this checkout, showing Docker's progress. */
async function buildLocalImage(): Promise<string> {
  console.log(`[e2e] building the worker image (${LOCAL_IMAGE})…`);
  await new Promise<void>((resolve, reject) => {
    const build = spawn("docker", ["build", "--file", "Dockerfile.worker", "--target", "run", "--tag", LOCAL_IMAGE, "."], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    const timer = setTimeout(() => build.kill("SIGTERM"), 20 * 60_000);
    build.on("error", reject);
    build.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`docker build of the worker image exited with ${code}`));
    });
  });
  return LOCAL_IMAGE;
}

async function logsOf(container: string): Promise<string> {
  const { stdout, stderr } = await docker(["logs", container]).catch(() => ({ stdout: "", stderr: "" }));
  return `${stdout}${stderr}`;
}

/** Starts the worker and waits until it takes jobs; returns what stops it again (and keeps its log). */
export async function startWorker(): Promise<() => Promise<void>> {
  const image = process.env.E2E_WORKER_IMAGE || (await buildLocalImage());
  await docker(["rm", "--force", CONTAINER]).catch(() => {});
  const environment = {
    ...TEST_DB_ENV,
    ...TEST_STORAGE_ENV,
    WORKER_SCRATCH_DIR: "/scratch",
    // Outside production a purge with no Cloudflare token is skipped: the e2e has no Cloudflare.
    NODE_ENV: "test",
  };
  await docker([
    "run",
    "--detach",
    "--name",
    CONTAINER,
    "--network",
    "host",
    // Scratch on a RAM disk the worker's own user owns, as the scratch disk is in production.
    "--tmpfs",
    "/scratch:rw,uid=10001,gid=10001,size=2g",
    ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    image,
  ]);

  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  for (;;) {
    const logs = await logsOf(CONTAINER);
    if (logs.includes("[worker] ready")) break;
    const { stdout: running } = await docker(["inspect", "--format", "{{.State.Running}}", CONTAINER]);
    if (running.trim() !== "true" || Date.now() > deadline) {
      await docker(["rm", "--force", CONTAINER]).catch(() => {});
      throw new Error(`The e2e worker didn't start:\n${logs}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("[e2e] the media worker is taking jobs");

  return async () => {
    await mkdir("test-results", { recursive: true });
    await writeFile("test-results/worker.log", await logsOf(CONTAINER));
    await docker(["rm", "--force", CONTAINER]).catch(() => {});
  };
}
