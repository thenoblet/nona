import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as zod from "zod";

/*
 * The media worker's settings, all from the environment and all checked here, once, at start-up.
 * The defaults suit nona-worker-01's container (about 3 CPUs and 12 GB, Ruling Q); for the backlog
 * week's bigger box, raise the container's CPUs and these together in Dokploy, with no code change.
 *
 * Thread counts are never left to the tools: sharp, x264 and ffmpeg's filters would each use every
 * core they can see, and inside Docker that is the host's, not the container's share (Ruling R).
 */

// Not NodeJS.ProcessEnv: Next's typings make NODE_ENV required there.
type Env = Record<string, string | undefined>;

/** How many jobs of each queue the worker runs at once. */
export type WorkerConcurrency = {
  photo: number;
  jpeg: number;
  poster: number;
  wish: number;
  visibility: number;
  card: number;
  /** media.convert's priority-20 jobs: a guest's phone asked, or the couple made it a highlight. */
  convertOnDemand: number;
  /** media.convert's other jobs, taken only while the admin's backlog switch is on. */
  convertBacklog: number;
};

/** Threads each job's tools may use. */
export type WorkerThreads = {
  /** x264's -threads in a conversion. */
  x264: number;
  /** sharp's (libvips') threads, set once with sharp.concurrency. */
  sharp: number;
  /** ffmpeg's -filter_threads and -filter_complex_threads (scaling, tone-mapping). */
  ffmpegFilters: number;
  /** heif-dec's --codec-threads and --tile-threads: libheif would otherwise decode 4 tiles at once. */
  heif: number;
  /** ffmpeg's -threads when it decodes a video's poster frame (and writes it). */
  poster: number;
  /**
   * ffmpeg's -threads before its input in a conversion: the decoder's, which would otherwise be
   * the host's CPUs (ffmpeg notes §4.14).
   */
  decoder: number;
};

/**
 * x264's presets, fastest first, that a conversion may use. Not placebo, which would take far
 * longer than a conversion's time for almost nothing.
 */
export const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] as const;
export type X264Preset = (typeof X264_PRESETS)[number];

export type WorkerConfig = {
  /** Where jobs make their scratch folders: the scratch disk's mount in production. */
  scratchRoot: string;
  concurrency: WorkerConcurrency;
  threads: WorkerThreads;
  /**
   * The most memory (address space) heif-dec and heif-info may take for one HEIC: a backstop
   * against a crafted file, far above a real photo's needs (a 48 MP HEIC decodes in about 300 MB).
   */
  heifMemoryBytes: number;
  /**
   * The most memory (address space) ffprobe and ffmpeg may take for one video's probe and poster:
   * a backstop against a crafted file. Measured in the worker image on one thread, a 4K HDR
   * poster needs about 830 MiB and an 8K one about 980 MiB.
   */
  ffmpegMemoryBytes: number;
  /**
   * The most memory (address space) a conversion's ffmpeg may take: a backstop against a crafted
   * file. Measured in the worker image under --cpus=3 at the default threads, a 4K HEVC HLG
   * conversion peaks at about 1,720 MiB and an 8K HEVC one at about 1,790 MiB.
   */
  convertMemoryBytes: number;
  /** x264's -preset in a conversion. */
  x264Preset: X264Preset;
  /** Connections in the job queue's pool: room for every handler's polling and heartbeats at once. */
  queuePoolSize: number;
};

/** A whole number from 1 to `max`, the default when unset or blank (Dokploy may leave one blank). */
function count(fallback: number, max = 64) {
  return zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod.coerce.number().int().min(1).max(max).default(fallback),
  );
}

const MEBIBYTE = 1024 * 1024;

/** A number of bytes from `min` to `max`, the default when unset or blank. */
function bytes(fallback: number, min: number, max: number) {
  return zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod.coerce.number().int().min(min).max(max).default(fallback),
  );
}

const schema = zod.object({
  WORKER_PHOTO_CONCURRENCY: count(2),
  WORKER_JPEG_CONCURRENCY: count(1),
  WORKER_POSTER_CONCURRENCY: count(1),
  WORKER_WISH_CONCURRENCY: count(1),
  WORKER_VISIBILITY_CONCURRENCY: count(2),
  WORKER_CARD_CONCURRENCY: count(1),
  WORKER_CONVERT_ON_DEMAND_CONCURRENCY: count(1),
  WORKER_CONVERT_BACKLOG_CONCURRENCY: count(1),
  WORKER_X264_THREADS: count(2),
  WORKER_SHARP_THREADS: count(1),
  WORKER_FFMPEG_FILTER_THREADS: count(1),
  WORKER_HEIF_THREADS: count(1),
  WORKER_POSTER_THREADS: count(1),
  // Measured: two decode a 4K HEVC clip in about real time; more only add memory (ffmpeg notes §4.14).
  WORKER_FFMPEG_DECODER_THREADS: count(2),
  WORKER_QUEUE_POOL_SIZE: count(10, 100),
  // Below 256 MiB heif-dec can't decode even a small photo.
  WORKER_HEIF_MEMORY_BYTES: bytes(2048 * MEBIBYTE, 256 * MEBIBYTE, 64 * 1024 * MEBIBYTE),
  // About twice an 8K poster's need. Below 1 GiB a 4K HDR poster can't be made: ffmpeg's libraries
  // alone take about 280 MiB of address space, and each of its threads a stack and a heap of its own.
  WORKER_FFMPEG_MEMORY_BYTES: bytes(2048 * MEBIBYTE, 1024 * MEBIBYTE, 64 * 1024 * MEBIBYTE),
  // About 1.7 times an 8K or 4K HDR conversion's need at the default threads (ffmpeg notes §4.14
  // suggests 3 GiB). Below 2 GiB a 4K HDR conversion can't run. Raising a conversion's threads
  // raises its need: measure again before.
  WORKER_CONVERT_MEMORY_BYTES: bytes(3072 * MEBIBYTE, 2048 * MEBIBYTE, 64 * 1024 * MEBIBYTE),
  WORKER_X264_PRESET: zod.preprocess((value) => (value === "" ? undefined : value), zod.enum(X264_PRESETS).default("veryfast")),
});

/**
 * The scratch folder's root: WORKER_SCRATCH_DIR, which production requires (the scratch disk is
 * mounted there; without it, scratch would fill the container's own disk). Elsewhere a folder of
 * the worker's own under the system's temp folder.
 */
function scratchRoot(env: Env): string {
  const configured = env.WORKER_SCRATCH_DIR?.trim();
  if (!configured) {
    if (env.NODE_ENV === "production") throw new Error("Missing worker setting: WORKER_SCRATCH_DIR");
    return join(tmpdir(), "nona-worker");
  }
  if (!isAbsolute(configured)) throw new Error("WORKER_SCRATCH_DIR must be an absolute path");
  return configured;
}

/** The worker's settings, or an error naming the first one that is wrong. */
export function workerConfig(env: Env = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`Invalid worker setting ${issue.path.join(".")}: ${issue.message}`);
  }
  const settings = parsed.data;
  return {
    scratchRoot: scratchRoot(env),
    concurrency: {
      photo: settings.WORKER_PHOTO_CONCURRENCY,
      jpeg: settings.WORKER_JPEG_CONCURRENCY,
      poster: settings.WORKER_POSTER_CONCURRENCY,
      wish: settings.WORKER_WISH_CONCURRENCY,
      visibility: settings.WORKER_VISIBILITY_CONCURRENCY,
      card: settings.WORKER_CARD_CONCURRENCY,
      convertOnDemand: settings.WORKER_CONVERT_ON_DEMAND_CONCURRENCY,
      convertBacklog: settings.WORKER_CONVERT_BACKLOG_CONCURRENCY,
    },
    threads: {
      x264: settings.WORKER_X264_THREADS,
      sharp: settings.WORKER_SHARP_THREADS,
      ffmpegFilters: settings.WORKER_FFMPEG_FILTER_THREADS,
      heif: settings.WORKER_HEIF_THREADS,
      poster: settings.WORKER_POSTER_THREADS,
      decoder: settings.WORKER_FFMPEG_DECODER_THREADS,
    },
    heifMemoryBytes: settings.WORKER_HEIF_MEMORY_BYTES,
    ffmpegMemoryBytes: settings.WORKER_FFMPEG_MEMORY_BYTES,
    convertMemoryBytes: settings.WORKER_CONVERT_MEMORY_BYTES,
    x264Preset: settings.WORKER_X264_PRESET,
    queuePoolSize: settings.WORKER_QUEUE_POOL_SIZE,
  };
}
