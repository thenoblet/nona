import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { readOriginalStream } from "@/lib/storage/objects";

/*
 * Scratch space: the folder each job downloads, decodes and converts in, on the scratch disk
 * (WORKER_SCRATCH_DIR, nona-worker-01's local NVMe in production). Every job gets a folder of its
 * own, made only once the disk has room for it, and removed when the job ends however it ends. A
 * worker killed mid-job leaves its folders behind; the next start removes them.
 */

// Every job folder's name starts with this, so a start removes only the worker's own leftovers.
const JOB_FOLDER_PREFIX = "job-";

let scratchRoot: string | null = null;

/** The disk doesn't have the room a job asked for. The job retries later, when others have finished. */
export class ScratchSpaceError extends Error {
  override name = "ScratchSpaceError";
}

/**
 * Makes the scratch root ready at start-up: creates it if missing, and removes every job folder an
 * earlier run left (a crash, a kill, a deploy mid-conversion). Anything else in it stays.
 */
export async function prepareScratchRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const leftovers = (await readdir(root)).filter((name) => name.startsWith(JOB_FOLDER_PREFIX));
  await Promise.all(leftovers.map((name) => rm(join(root, name), { recursive: true, force: true })));
  scratchRoot = root;
}

function preparedRoot(): string {
  if (!scratchRoot) throw new Error("The scratch root isn't ready: call prepareScratchRoot at start-up");
  return scratchRoot;
}

/** The bytes free on the scratch disk for the worker's use. */
export async function freeScratchBytes(): Promise<number> {
  const disk = await statfs(preparedRoot());
  return disk.bavail * disk.bsize;
}

/**
 * Runs `task` with an empty folder of its own on the scratch disk, then removes the folder whether
 * the task succeeds or throws. Checks first that the disk has `bytesNeeded` free (a conversion asks
 * for twice its original), and throws ScratchSpaceError without making the folder when it hasn't.
 */
export async function withScratch<TResult>(
  bytesNeeded: number,
  task: (folder: string) => Promise<TResult>,
): Promise<TResult> {
  const root = preparedRoot();
  const free = await freeScratchBytes();
  if (free < bytesNeeded) {
    throw new ScratchSpaceError(`The scratch disk has ${free} bytes free; this job needs ${bytesNeeded}`);
  }
  const folder = await mkdtemp(join(root, JOB_FOLDER_PREFIX));
  try {
    return await task(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * Streams an original from the private bucket into `path`, never holding it in memory. Pass the
 * job's signal (Ruling L): the download has no overall deadline of its own, since an original can
 * be 2 GB, so the job's expiry or the worker stopping is what ends a slow one. A download that
 * sends nothing for 10 s fails by itself.
 */
export async function saveOriginal(originalKey: string, path: string, signal: AbortSignal): Promise<void> {
  const download = await readOriginalStream(originalKey, { signal });
  await pipeline(download, createWriteStream(path), { signal });
}
