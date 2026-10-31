import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { readSection } from "@/lib/content/store";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { assignCelebration } from "@/lib/media/celebration";
import { plausibleCaptureTime } from "@/lib/media/capture-time";
import { findItemToProcess, markVideoReady } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, PLAYBACK_URL_SECONDS, presignGet, putPublicObject } from "@/lib/storage/objects";
import { ProcessError } from "../processes";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { withScratch } from "../scratch";
import { describeEnding, killedFromOutside, runCapped, toolDidNotRun } from "./capped-tools";
import { contentHashOf, rewriteManifest, withdrawIfHidden } from "./publishing";
import { deriveStills, VIEW, type Stills } from "./stills";
import {
  PROBE_ENTRIES,
  VIDEO_DEMUXERS,
  videoFactsFrom,
  type HdrColours,
  type SdrColours,
  type VideoFacts,
} from "./video-probe";

/*
 * media.poster: an uploaded video becomes what the album shows, without its original ever being
 * downloaded. ffprobe and ffmpeg read it where it is, over a 2-hour presigned link, by range
 * requests (the commands follow the ffmpeg notes, §2.0–§2.2):
 * 1. ffprobe describes it (video-probe.ts): it must be a video the album takes (layer 3), and its
 *    duration, codec, size, display matrix, colours, audio and capture time are read.
 * 2. ffmpeg seeks to min(1 s, half the video stream's duration) and decodes one frame there,
 *    upright (see posterArgs), shrunk to fit 1600 px with even sides and, for HDR, tone-mapped to
 *    SDR; when nothing is there to decode (a clip of a frame or two), it tries the start. sharp makes
 *    the poster's viewing size, thumbnail, ThumbHash and average colour from it (stills.ts).
 * Then the two files go to the public bucket under a content hash, and the item turns `ready`,
 * listed, in the celebration its capture time falls in (unless the couple moved it), with whether
 * every phone can play it as it is. A video that can't be played everywhere, or is long, is queued
 * for a backlog conversion (media.convert, Task 11), sent once.
 *
 * Both tools run under a memory cap (WORKER_FFMPEG_MEMORY_BYTES) on WORKER_POSTER_THREADS and
 * WORKER_FFMPEG_FILTER_THREADS threads, and read through bounded reconnects. Over the network a
 * stalled read looks like a damaged file ("moov atom not found", "Invalid data found"), so a
 * failure that seems to be the file's is retried, and is taken as `corrupt` only on the third
 * attempt (Ruling AO). A format the album doesn't take is `unsupported-type` at once: no stall makes
 * ffmpeg recognise a JPEG. The presigned link is a credential: runProcess takes it out of what the
 * tools print, so no error or log holds it. A job for an item no longer `uploaded`, or hidden or
 * deleted, does nothing (Ruling AG).
 */

/**
 * Part of every poster file's key. Raise it whenever what this job makes changes (a size, a
 * quality, the frame it takes, the tone-mapping), so the files made again get new keys.
 */
const POSTER_SETTINGS_VERSION = 2;
/** The poster's frame is at most this far in: past a fade-in or a shaky start, but early in any clip. */
const POSTER_AT_MOST_SECONDS = 1;
/** A video longer than this gets a backlog conversion even when it plays everywhere: its original is large to stream. */
const LONG_VIDEO_SECONDS = 3 * 60;
/**
 * From this attempt on (pg-boss's retryCount: the third attempt), a failure that looks like the
 * file's is taken to be: a stalled read wouldn't fail the same way three times, minutes apart.
 */
const FILE_BLAMED_FROM_RETRY = 2;
/** ffprobe and ffmpeg give up on a read or write that makes no progress for this long (in microseconds: 10 s). */
const READ_TIMEOUT_MICROSECONDS = 10_000_000;
/**
 * How much ffprobe and ffmpeg read to find the streams' details: ffmpeg's own defaults, stated so a
 * change of default can't move them. They bound only that probing, not the container's index (a
 * crafted MOV's whole `moov` is read whatever they say); what bounds a crafted file is the memory
 * cap, the time limits and the two whitelists (ffmpeg notes §4.5).
 */
const PROBE_BYTES = 5_000_000;
const PROBE_MICROSECONDS = 5_000_000;
/** ffprobe reads only the container's index and a few MB: well under a second for a phone's video. */
const PROBE_MILLISECONDS = 60_000;
/**
 * ffmpeg decodes from the keyframe before the poster's frame. Measured on one thread in the worker
 * image: a 4K HDR iPhone-like clip about 4 s, an 8K one about 12 s.
 */
const POSTER_MILLISECONDS = 120_000;
/** Scratch for the frames ffmpeg writes (at most 1600 × 1600 RGB as PNG, twice). */
const POSTER_SCRATCH_BYTES = 64 * 1024 * 1024;
/**
 * The bounded reconnects of ffmpeg's http protocol (ffmpeg notes §2.0, §4.4): a dropped or stalled
 * connection, or a 5xx from R2, is tried again twice, at most 4 s apart, before the read fails. A
 * 4xx isn't: an expired link answers 403.
 */
const RECONNECTS = [
  ...["-reconnect", "1", "-reconnect_on_network_error", "1", "-reconnect_on_http_error", "5xx"],
  ...["-reconnect_max_retries", "2", "-reconnect_delay_max", "4"],
];

/** What the job takes from the worker's settings. */
export type PosterOptions = {
  /** The memory (address space) ffprobe and ffmpeg may take: WORKER_FFMPEG_MEMORY_BYTES. */
  ffmpegMemoryBytes: number;
  /** ffmpeg's -threads, decoding the frame and writing it: WORKER_POSTER_THREADS. */
  posterThreads: number;
  /** ffmpeg's -filter_threads (shrinking, tone-mapping): WORKER_FFMPEG_FILTER_THREADS. */
  filterThreads: number;
  /** The job queue the video's conversion is sent to. */
  jobQueue: () => Promise<Pick<PgBoss, "send">>;
};

/** Where and how a job runs ffprobe and ffmpeg. */
type VideoContext = PosterOptions & {
  /** The presigned link to the original: a credential, never logged. */
  link: string;
  folder: string;
  signal: AbortSignal;
  /** The job's retries so far: a failure that looks like the file's is blamed on it from the third attempt. */
  retryCount: number;
};

/** What the scratch folder's work made. */
type Poster = { facts: VideoFacts; stills: Stills; probeMilliseconds: number; posterMilliseconds: number };

// Something between the tool and R2 failed, not the file: a protocol layer complained (ffmpeg
// names it in its log line), R2 answered with an HTTP error, or the connection was refused, reset,
// cut short, timed out or never made (DNS). ffmpeg sees the network through avio, whose errors end
// as "Input/output error".
const NETWORK_TROUBLE = new RegExp(
  [
    "^\\[(?:tcp|tls|http|https) @",
    "Server returned",
    "HTTP error",
    "Connection refused",
    "Connection reset",
    "Connection timed out",
    "Operation timed out",
    "Failed to resolve hostname",
    "Network is unreachable",
    "No route to host",
    "Input/output error",
    "Broken pipe",
    "Stream ends prematurely",
    "Error in the pull function",
  ].join("|"),
  "m",
);
// A thread the tool couldn't start (EAGAIN): the worker's limits on threads or memory, not the file.
const NO_THREAD = /pthread_create|Resource temporarily unavailable/;
// The tool refused one of its own options: the image's ffmpeg isn't the 7.1 the job was written
// for (ffmpeg 4.4 has no -reconnect_max_retries). The worker's build, never the file (Ruling AP).
const UNKNOWN_OPTION = /Option not found|Unrecognized option/;
// What ffmpeg says when it recognised the file as a format other than the two it may open.
const NOT_ALLOWED_FORMAT = /Format not on whitelist/;

/** The last line a tool printed (runProcess has already taken any link out). */
function lastLineOf(stderr: string): string {
  return stderr.trim().split("\n").at(-1) ?? "";
}

/**
 * A failure that looks like the file's: from the third attempt it is, `corrupt`, for good. Before
 * that it is retried, since over the network a stalled read fails the same way (ffmpeg notes §4.4).
 */
function blameFileFromThirdAttempt(message: string, retryCount: number): Error {
  if (retryCount >= FILE_BLAMED_FROM_RETRY) return new PermanentJobError("corrupt", message);
  return new Error(`${message} (tried again: a stalled read from R2 looks the same)`);
}

/**
 * What ffprobe or ffmpeg failing on an original means. Every error it returns is new, with no
 * cause; what the tool printed comes from runProcess with the link already taken out.
 * - `unsupported-type` at once: ffmpeg recognised a format other than the two allowed.
 * - Retried, always: R2 or the network failed the read; a thread couldn't start (EAGAIN); a SIGKILL
 *   from outside (the OOM killer); the tool ran past its time (it reads over the network, so a slow
 *   read can't be told from a slow file); the job ended; the worker stopped; the tool couldn't run,
 *   or didn't know one of its options (an image built with another ffmpeg).
 * - Anything else looks like the file's fault (the tool refused it, died on it, ran out of memory
 *   under the cap, or printed far too much): retried twice, then `corrupt`.
 * Exported for its test.
 */
export function videoToolFailure(
  tool: "ffprobe" | "ffmpeg",
  error: unknown,
  context: { memoryBytes: number; retryCount: number },
): Error {
  if (!(error instanceof ProcessError)) {
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : "an unknown error";
    return new Error(`${tool} couldn't run: ${name}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  const lastLine = lastLineOf(error.stderrTail);
  const ending = describeEnding(error);
  if (error.ending === "too-much-output") {
    return blameFileFromThirdAttempt(`${tool} printed far too much reading the video: ${ending}`, context.retryCount);
  }
  if (error.ending !== "exit") return new Error(`${tool} didn't finish reading the video: ${ending}`);
  if (toolDidNotRun(error)) return new Error(`${tool} couldn't run: ${ending}: ${lastLine}`);
  if (UNKNOWN_OPTION.test(error.stderrTail)) {
    return new Error(`${tool} doesn't know an option the worker gave it (is it ffmpeg 7.1?): ${ending}: ${lastLine}`);
  }
  if (killedFromOutside(error)) return new Error(`${tool} was killed from outside the worker: ${ending}`);
  if (error.exitCode !== null && NOT_ALLOWED_FORMAT.test(error.stderrTail)) {
    const refusal = error.stderrTail.split("\n").find((line) => NOT_ALLOWED_FORMAT.test(line)) ?? lastLine;
    return new PermanentJobError("unsupported-type", `The original isn't a video the album takes: ${refusal.trim()}`);
  }
  if (error.exitCode !== null && NETWORK_TROUBLE.test(error.stderrTail)) {
    return new Error(`${tool} couldn't read the original from R2: ${ending}: ${lastLine}`);
  }
  if (NO_THREAD.test(error.stderrTail)) {
    return new Error(`${tool} couldn't start its threads, under a ${context.memoryBytes}-byte cap: ${ending}: ${lastLine}`);
  }
  return blameFileFromThirdAttempt(
    `${tool} couldn't read the video, under a ${context.memoryBytes}-byte cap: ${ending}: ${lastLine}`,
    context.retryCount,
  );
}

/** Runs ffprobe or ffmpeg under the memory cap (runCapped), the link kept out of what it prints, its failure told apart by videoToolFailure. */
async function runVideoTool(
  tool: "ffprobe" | "ffmpeg",
  args: string[],
  context: VideoContext,
  timeoutMilliseconds: number,
): Promise<{ stdout: string; stderrTail: string }> {
  try {
    return await runCapped(tool, args, {
      memoryBytes: context.ffmpegMemoryBytes,
      signal: context.signal,
      timeoutMilliseconds,
      cwd: context.folder,
      redact: { link: context.link, as: "the original" },
    });
  } catch (error) {
    throw videoToolFailure(tool, error, { memoryBytes: context.ffmpegMemoryBytes, retryCount: context.retryCount });
  }
}

/**
 * The protocols the link may open: https and what it runs on in production, plain http only for
 * the local MinIO. Nothing else, so no file: and nothing a crafted file points at.
 */
function protocolsFor(link: string): string {
  return new URL(link).protocol === "https:" ? "https,tls,tcp" : "http,tcp";
}

/**
 * How ffprobe and ffmpeg open the original: over the link only, with a 10 s read timeout and
 * bounded reconnects, as one of the two video demuxers only, probing no more than ffmpeg's defaults.
 */
function readingArgs(link: string): string[] {
  return [
    ...["-protocol_whitelist", protocolsFor(link)],
    ...["-rw_timeout", String(READ_TIMEOUT_MICROSECONDS)],
    ...RECONNECTS,
    ...["-format_whitelist", VIDEO_DEMUXERS],
    ...["-probesize", String(PROBE_BYTES)],
    ...["-analyzeduration", String(PROBE_MICROSECONDS)],
  ];
}

/** ffprobe's description of the original, checked: a video the album takes, and its facts. */
async function probe(context: VideoContext): Promise<VideoFacts> {
  const args = ["-hide_banner", "-loglevel", "error", ...readingArgs(context.link)];
  args.push("-print_format", "json", "-show_error", "-show_entries", PROBE_ENTRIES, context.link);
  const { stdout } = await runVideoTool("ffprobe", args, context, PROBE_MILLISECONDS);
  let description: unknown;
  try {
    description = JSON.parse(stdout);
  } catch {
    throw blameFileFromThirdAttempt("ffprobe's description of the original isn't JSON", context.retryCount);
  }
  // What ffprobe read is the container's own header: no stall makes it describe another file, so
  // its refusals stand at once.
  const check = videoFactsFrom(description);
  if (!check.ok) throw new PermanentJobError(check.reason, `The original is ${check.found}, not a video the album takes`);
  return check.facts;
}

/**
 * Shrunk to fit 1600 px on its long edge, never enlarged, with even sides: what sharp then shrinks
 * further, and what an HDR frame is tone-mapped at (not at its full 4K). zscale refuses a 4:2:0
 * frame with an odd side ("code 1027"), as 2560 × 1080 fitted to 1600 × 675 would be.
 */
const FIT_VIEW = `scale=w='min(${VIEW.longEdge},iw)':h='min(${VIEW.longEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

// The YUV matrices as scale names them (it has no "bt470bg").
const SCALE_MATRIX: Record<SdrColours["matrix"], string> = {
  bt709: "bt709",
  smpte170m: "smpte170m",
  bt470bg: "bt470",
  bt2020nc: "bt2020",
};
// The colours as zscale's documentation names them (ffmpeg-filters, zscale).
const ZSCALE_MATRIX: Record<HdrColours["matrix"], string> = { bt2020nc: "2020_ncl", bt2020c: "2020_cl", bt709: "709" };
const ZSCALE_PRIMARIES: Record<HdrColours["primaries"], string> = { bt2020: "2020", bt709: "709" };
const ZSCALE_RANGE: Record<HdrColours["range"], string> = { tv: "limited", pc: "full" };

/**
 * ffmpeg's filters for the poster's frame (no turn among them: see posterArgs). Every colour named
 * is one video-probe.ts allowed, never the file's own text.
 * - SDR: scale turns YUV into RGB by the matrix and range the probe found, BT.709 when it found
 *   none: left to itself it would read an untagged video as BT.601 (ffmpeg notes §2.0, §4.9).
 * - HDR (PQ or HLG): zscale makes it linear light from its own colours, in BT.709 primaries,
 *   tonemap's hable curve brings its highlights into SDR's range, and zscale encodes it as BT.709
 *   (ffmpeg notes §4.7).
 * Every frame ends as 8-bit RGB for the PNG sharp reads.
 */
function posterFilters(facts: VideoFacts): string {
  const { hdr, sdr } = facts;
  if (!hdr) {
    const inRange = sdr.range === "pc" ? "pc" : "tv";
    return `${FIT_VIEW}:in_color_matrix=${SCALE_MATRIX[sdr.matrix]}:in_range=${inRange},format=rgb24`;
  }
  const input = `tin=${hdr.transfer}:min=${ZSCALE_MATRIX[hdr.matrix]}:pin=${ZSCALE_PRIMARIES[hdr.primaries]}:rin=${ZSCALE_RANGE[hdr.range]}`;
  return [
    FIT_VIEW,
    `zscale=${input}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=709:m=709:r=limited",
    "format=yuv420p",
    "format=rgb24",
  ].join(",");
}

/**
 * Where in the video the poster's frame is: min(1 s, half the video stream's own duration, else the
 * container's), or its start when neither says.
 */
function posterSeconds(facts: VideoFacts): number {
  const length = facts.videoStreamSeconds ?? facts.durationSeconds;
  return length === null ? 0 : Math.min(POSTER_AT_MOST_SECONDS, Number((length / 2).toFixed(3)));
}

/**
 * ffmpeg's arguments for the poster's frame at `seconds`, written as a PNG to `output` (ffmpeg
 * notes §2.0, §2.2).
 * - -xerror: the first read or decode error fails the run, rather than ending the input as if it
 *   were the file's end, leaving a frame decoded from a partial packet.
 * - `-ss` before `-i`: ffmpeg seeks in the container's index and reads from the keyframe before
 *   the frame by one range request, then decodes up to the frame itself (accurate seek, its default).
 * - The frame is turned upright by ffmpeg itself: its autorotate, on unless -noautorotate, turns
 *   each decoded frame by the stream's display matrix before the filters below. So no turn of our
 *   own is added (it would turn a portrait iPhone video twice), and the size the album keeps is the
 *   probe's turned the same way (video-probe.ts).
 * - Its threads are pinned (Ruling R): -threads for decoding and writing, -filter_threads for the
 *   filters. -map_metadata -1: the frame carries none of the file's tags.
 */
function posterArgs(facts: VideoFacts, context: VideoContext, seconds: number, output: string): string[] {
  const threads = String(context.posterThreads);
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-xerror", "-y"],
    ...["-filter_threads", String(context.filterThreads)],
    ...readingArgs(context.link),
    ...["-threads", threads, "-ss", String(seconds), "-i", context.link],
    ...["-map", `0:${facts.streamIndex}`, "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1"],
    ...["-vf", posterFilters(facts), "-threads", threads],
    ...["-c:v", "png", "-f", "image2", "-update", "1", output],
  ];
}

/** The size of what ffmpeg wrote, 0 when it wrote nothing. */
async function sizeOf(path: string): Promise<number> {
  return stat(path).then(
    (file) => file.size,
    () => 0,
  );
}

/**
 * The poster's frame as a PNG in the scratch folder. ffmpeg exits with 0 having written nothing
 * when there is no frame where it seeks (a clip of a frame or two: ffmpeg notes §4.17), so then it
 * tries the very start, into a file of its own.
 */
async function posterFrame(facts: VideoFacts, context: VideoContext): Promise<string> {
  const seconds = posterSeconds(facts);
  const output = join(context.folder, "poster.png");
  await runVideoTool("ffmpeg", posterArgs(facts, context, seconds, output), context, POSTER_MILLISECONDS);
  if ((await sizeOf(output)) > 0) return output;
  if (seconds > 0) {
    const fromStart = join(context.folder, "poster-from-start.png");
    await runVideoTool("ffmpeg", posterArgs(facts, context, 0, fromStart), context, POSTER_MILLISECONDS);
    if ((await sizeOf(fromStart)) > 0) return fromStart;
  }
  throw blameFileFromThirdAttempt("ffmpeg found no frame for the poster", context.retryCount);
}

/** Probes the original and makes its poster's files, in the job's scratch folder. */
async function posterOf(context: VideoContext): Promise<Poster> {
  const probeStartedAt = performance.now();
  const facts = await probe(context);
  const posterStartedAt = performance.now();
  const stills = await deriveStills({
    path: await posterFrame(facts, context),
    maxPixels: VIEW.longEdge * VIEW.longEdge,
    autoOrient: false,
    kind: "poster",
  });
  return {
    facts,
    stills,
    probeMilliseconds: Math.round(posterStartedAt - probeStartedAt),
    posterMilliseconds: Math.round(performance.now() - posterStartedAt),
  };
}

/**
 * Sends the video's backlog conversion (media.convert, below the on-demand priority). Never throws:
 * the row says `queued`, so if this fails the sweeper sends it within its next sweep.
 */
async function sendConversion(mediaId: string, options: PosterOptions): Promise<void> {
  try {
    const queue = await options.jobQueue();
    await queue.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.backlog });
  } catch (error) {
    console.error(
      `[worker] media.poster media=${mediaId} is ready, but its conversion wasn't sent; the sweeper will send it:`,
      describeError(error),
    );
  }
}

/** media.poster's work for one job, whose data is `{ mediaId }`. */
export async function processVideo(job: MediaJob, options: PosterOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const item = await findItemToProcess(mediaId);
  if (!item) {
    console.log(`[worker] media.poster job=${job.id}: nothing to do, the item is no longer uploaded, or hidden or deleted`);
    return;
  }
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);
  const link = await presignGet(item.originalKey, { expiresInSeconds: PLAYBACK_URL_SECONDS });

  const poster = await withScratch(POSTER_SCRATCH_BYTES, (folder) =>
    posterOf({ ...options, link, folder, signal: job.signal, retryCount: job.retryCount }),
  );
  const { facts, stills } = poster;
  console.log(
    `[worker] media.poster job=${job.id} media=${mediaId}: probed in ${poster.probeMilliseconds} ms, poster in ${poster.posterMilliseconds} ms`,
  );
  // A time from a reset or wrong clock counts as none: the file's, then the phone's, then the upload's.
  const capturedAt =
    plausibleCaptureTime(facts.capturedAt, item.startedAt) ?? plausibleCaptureTime(item.capturedAt, item.startedAt);
  const { value: celebrations } = await readSection("celebrations");
  const contentHash = contentHashOf(original.etag, `poster-settings-${POSTER_SETTINGS_VERSION}`);
  const keys = {
    "poster-thumb": derivedKey(mediaId, contentHash, "poster-thumb", "webp"),
    "poster-view": derivedKey(mediaId, contentHash, "poster-view", "webp"),
  };
  await Promise.all([
    putPublicObject(keys["poster-thumb"], stills.thumb, "image/webp", { signal: job.signal }),
    putPublicObject(keys["poster-view"], stills.view, "image/webp", { signal: job.signal }),
  ]);

  const marked = await markVideoReady(mediaId, {
    derived: keys,
    width: facts.width,
    height: facts.height,
    thumbhash: stills.placeholder.thumbhash,
    averageColor: stills.placeholder.averageColor,
    capturedAt,
    celebration: assignCelebration(capturedAt, item.startedAt, celebrations),
    durationSeconds: facts.durationSeconds,
    videoCodec: facts.codec,
    browserPlayable: facts.browserPlayable,
    needsConversion: !facts.browserPlayable || (facts.durationSeconds ?? 0) > LONG_VIDEO_SECONDS,
  });
  if (!marked) {
    await withdrawIfHidden(job.queue, mediaId, [keys["poster-thumb"], keys["poster-view"]], job.signal);
    return;
  }
  if (marked.conversionQueued) await sendConversion(mediaId, options);
  await rewriteManifest(job.queue, mediaId, marked.manifest, job.signal);
  return { sizeBytes: original.size, kind: `video/${facts.codec}${facts.hdr ? "-hdr" : ""}` };
}

/** media.poster's handler, with the worker's settings. */
export function posterHandler(options: PosterOptions): MediaJobHandler {
  return (job) => processVideo(job, options);
}
