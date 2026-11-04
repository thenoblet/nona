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
  /** media.playable: a video's clean copy (a stream copy, no encoding), a download and an upload of its size. */
  playable: number;
};

/** Threads each job's tools may use. */
export type WorkerThreads = {
  /** x264's -threads in a conversion that starts beside another (a lone one takes `cpus`). */
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
   * ffmpeg's -threads before its input in a conversion that starts beside another: the decoder's,
   * which would otherwise be the host's CPUs (ffmpeg notes §4.14). A lone one takes `cpus`.
   */
  decoder: number;
};

/**
 * x264's presets, fastest first, that a conversion may use. Not placebo, which would take far
 * longer than a conversion's time for almost nothing.
 */
export const X264_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"] as const;
export type X264Preset = (typeof X264_PRESETS)[number];

/** x264's -maxrate:v and -bufsize:v, in ffmpeg's notation. */
export type X264Cap = { maxRate: string; bufferSize: string };

export type WorkerConfig = {
  /** Where jobs make their scratch folders: the scratch disk's mount in production. */
  scratchRoot: string;
  concurrency: WorkerConcurrency;
  threads: WorkerThreads;
  /**
   * The CPUs the container may use (its limit, not the host's count, which is what the tools
   * would see): a conversion that starts while no other runs gives its decoder and x264 this many
   * threads each (Noblet, Task 14b).
   */
  cpus: number;
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
   * file. Its need grows with its threads (conversionPeakBytes): by default 3 GiB, or 1.6 times a
   * lone conversion's need on WORKER_CPUS threads where that is more.
   */
  convertMemoryBytes: number;
  /** x264's -preset in a conversion. */
  x264Preset: X264Preset;
  /**
   * A conversion's bitrate cap, off (null) unless WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE are
   * both set: x264's -maxrate:v and -bufsize:v, in ffmpeg's notation ("5M", "4500k" or bits a
   * second), the notes' "capped CRF" (§2.3). Off, a conversion is pure CRF 23 (Noblet, 31 Oct: a
   * cap would cost quality in the scenes that matter, dancing, confetti, low light, grain).
   */
  x264Cap: X264Cap | null;
  /**
   * The longest video the worker converts, in seconds (Ruling AR), and, times 60, the most frames
   * (its length times its frame rate, counted at most 240: Ruling BG). A longer one's conversion, or
   * one with more frames, is `failed` with the reason `too-long` at once: it plays from its playable
   * copy where a phone can, and its original stays downloadable.
   */
  convertMaxSeconds: number;
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

/**
 * A bitrate in ffmpeg's notation, or unset: a positive number of bits a second, with an optional SI
 * suffix, k (thousand) or M (million), as ffmpeg's "5M" (ffmpeg-utils, "Expression Evaluation").
 * Nothing else, so it can't carry another option into ffmpeg's arguments.
 */
function bitrate() {
  return zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod
      .string()
      .regex(/^(?:[1-9][0-9]*|[0-9]+\.[0-9]*[1-9][0-9]*)[kM]?$/, "a bitrate such as 5M, 4500k or 5000000")
      .optional(),
  );
}

/** A number of bytes from `min` to `max`, the default when unset or blank. */
function bytes(fallback: number, min: number, max: number) {
  return zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod.coerce.number().int().min(min).max(max).default(fallback),
  );
}

/** A number of bytes from `min` to `max`, or unset (blank counts as unset). */
function optionalBytes(min: number, max: number) {
  return zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod.coerce.number().int().min(min).max(max).optional(),
  );
}

/** A conversion's memory cap when WORKER_CONVERT_MEMORY_BYTES isn't set, at least (ffmpeg notes §4.14 suggests 3 GiB). */
const CONVERT_MEMORY_FLOOR_BYTES = 3072 * MEBIBYTE;

/**
 * The address space a conversion's ffmpeg peaks at on `threads` decoder and x264 threads each and
 * `filterThreads` filter threads. Measured in the worker image (Task 14b) on the costliest phone
 * video measured, an iPhone-like portrait 4K HEVC HLG clip, alone: 1,873 MiB on 3 threads, 2,614
 * on 8, 3,834 on 16 (8K HEVC on 3: 1,753), so about 1,450 MiB and 150 more for each thread of each;
 * every filter thread past the first, about 85 more (1080p HLG on 3 each: 1,562 MiB with one filter
 * thread, 1,730 with three). Every thread takes a stack and a heap (malloc arena) of its own,
 * mostly reserved, never used.
 */
export function conversionPeakBytes(threads: number, filterThreads = 1): number {
  return (1450 + 150 * threads + 85 * Math.max(0, filterThreads - 1)) * MEBIBYTE;
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
  WORKER_PLAYABLE_CONCURRENCY: count(1),
  // nona-worker-01's container limit (Ruling Q): a lone conversion's threads.
  WORKER_CPUS: count(3),
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
  // Unset, from the threads (convertMemoryDefault). Below 2 GiB a 4K HDR conversion can't run.
  WORKER_CONVERT_MEMORY_BYTES: optionalBytes(2048 * MEBIBYTE, 64 * 1024 * MEBIBYTE),
  WORKER_X264_PRESET: zod.preprocess((value) => (value === "" ? undefined : value), zod.enum(X264_PRESETS).default("veryfast")),
  // Off unless both are set (Noblet, 31 Oct): e.g. 5M and 10M, should mobile data become a concern.
  WORKER_X264_MAXRATE: bitrate(),
  WORKER_X264_BUFSIZE: bitrate(),
  // Half an hour: past the longest speech, and a conversion that fits its time and CPU limits.
  WORKER_CONVERT_MAX_SECONDS: zod.preprocess(
    (value) => (value === "" ? undefined : value),
    zod.coerce.number().int().min(60).max(24 * 3600).default(1800),
  ),
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

/**
 * A conversion's memory cap when WORKER_CONVERT_MEMORY_BYTES isn't set: 3 GiB, or 1.6 times a
 * conversion's need on its threads where that is more (WORKER_CPUS raised for a bigger box), in
 * whole 256 MiB.
 */
function convertMemoryDefault(needBytes: number): number {
  const step = 256 * MEBIBYTE;
  return Math.max(CONVERT_MEMORY_FLOOR_BYTES, Math.ceil((1.6 * needBytes) / step) * step);
}

/** The worker's settings, or an error naming the first one that is wrong. */
export function workerConfig(env: Env = process.env): WorkerConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    throw new Error(`Invalid worker setting ${issue.path.join(".")}: ${issue.message}`);
  }
  const settings = parsed.data;
  // A conversion's most threads: a lone one's (WORKER_CPUS), or the shared counts if set higher.
  const conversionThreads = Math.max(settings.WORKER_CPUS, settings.WORKER_FFMPEG_DECODER_THREADS, settings.WORKER_X264_THREADS);
  const conversionNeed = conversionPeakBytes(conversionThreads, settings.WORKER_FFMPEG_FILTER_THREADS);
  const configuredConvertMemory = settings.WORKER_CONVERT_MEMORY_BYTES;
  // A cap under a 4K HDR conversion's need would fail every one as the file's fault, `corrupt` on
  // its third attempt: refused here, at start-up, instead.
  if (configuredConvertMemory !== undefined && configuredConvertMemory < conversionNeed) {
    throw new Error(
      `Invalid worker setting WORKER_CONVERT_MEMORY_BYTES: ${configuredConvertMemory} bytes is under the ${conversionNeed} a 4K HDR ` +
        `conversion needs on ${conversionThreads} threads (WORKER_CPUS); raise it with WORKER_CPUS, or leave it unset`,
    );
  }
  const maxRate = settings.WORKER_X264_MAXRATE;
  const bufferSize = settings.WORKER_X264_BUFSIZE;
  // One without the other is a half-made setting: x264's VBV needs both.
  if ((maxRate === undefined) !== (bufferSize === undefined)) {
    throw new Error("Invalid worker setting WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE: set both to cap conversions, or neither");
  }
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
      playable: settings.WORKER_PLAYABLE_CONCURRENCY,
    },
    threads: {
      x264: settings.WORKER_X264_THREADS,
      sharp: settings.WORKER_SHARP_THREADS,
      ffmpegFilters: settings.WORKER_FFMPEG_FILTER_THREADS,
      heif: settings.WORKER_HEIF_THREADS,
      poster: settings.WORKER_POSTER_THREADS,
      decoder: settings.WORKER_FFMPEG_DECODER_THREADS,
    },
    cpus: settings.WORKER_CPUS,
    heifMemoryBytes: settings.WORKER_HEIF_MEMORY_BYTES,
    ffmpegMemoryBytes: settings.WORKER_FFMPEG_MEMORY_BYTES,
    convertMemoryBytes: configuredConvertMemory ?? convertMemoryDefault(conversionNeed),
    x264Preset: settings.WORKER_X264_PRESET,
    x264Cap: maxRate !== undefined && bufferSize !== undefined ? { maxRate, bufferSize } : null,
    convertMaxSeconds: settings.WORKER_CONVERT_MAX_SECONDS,
    queuePoolSize: settings.WORKER_QUEUE_POOL_SIZE,
  };
}
