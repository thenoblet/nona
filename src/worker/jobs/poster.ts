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
import { PROBE_ENTRIES, VIDEO_DEMUXERS, videoFactsFrom, type HdrColours, type VideoFacts } from "./video-probe";

/*
 * media.poster: an uploaded video becomes what the album shows, without its original ever being
 * downloaded. ffprobe and ffmpeg read it where it is, over a 2-hour presigned link, by range
 * requests:
 * 1. ffprobe describes it (video-probe.ts): it must be a video the album takes (layer 3), and its
 *    duration, codec, size, display matrix, colours, audio and capture time are read.
 * 2. ffmpeg seeks to min(1 s, half its duration) and decodes one frame there, upright (see
 *    posterArgs), shrunk to fit 1600 px and, for HDR, tone-mapped to SDR. sharp makes the poster's
 *    viewing size, thumbnail, ThumbHash and average colour from it (stills.ts), as for a photo.
 * Then the two files go to the public bucket under a content hash, and the item turns `ready`,
 * listed, in the celebration its capture time falls in (unless the couple moved it), with whether
 * every phone can play it as it is. A video that can't be played everywhere, or is long, is queued
 * for a backlog conversion (media.convert, Task 11), sent once.
 *
 * Both tools run under a memory cap (WORKER_FFMPEG_MEMORY_BYTES) on WORKER_POSTER_THREADS and
 * WORKER_FFMPEG_FILTER_THREADS threads. A file they refuse, die on or hit the cap with fails for
 * good, `corrupt` (or `unsupported-type` for a container the album doesn't take); R2 or the network
 * failing them, or anything else that is the worker's trouble, retries. The presigned link is a
 * credential: it is never logged, and is taken out of anything the tools print before that reaches
 * an error. A job for an item no longer `uploaded`, or hidden or deleted, does nothing (Ruling AG).
 */

/**
 * Part of every poster file's key. Raise it whenever what this job makes changes (a size, a
 * quality, the frame it takes, the tone-mapping), so the files made again get new keys.
 */
const POSTER_SETTINGS_VERSION = 1;
/** The poster's frame is at most this far in: past a fade-in or a shaky start, but early in any clip. */
const POSTER_AT_MOST_SECONDS = 1;
/** A video longer than this gets a backlog conversion even when it plays everywhere: its original is large to stream. */
const LONG_VIDEO_SECONDS = 3 * 60;
/** ffprobe and ffmpeg give up on a read or write that makes no progress for this long (in microseconds: 10 s). */
const READ_TIMEOUT_MICROSECONDS = 10_000_000;
/**
 * How much ffprobe and ffmpeg read to find the streams' details (ffmpeg's own defaults, stated so
 * no change of default can loosen them): a crafted file can't make them read the whole object.
 */
const PROBE_BYTES = 5_000_000;
const PROBE_MICROSECONDS = 5_000_000;
/** ffprobe reads only the container's index and a few MB: well under a second for a phone's video. */
const PROBE_MILLISECONDS = 60_000;
/**
 * ffmpeg decodes from the keyframe before the poster's frame. Measured on one thread in the worker
 * image: a 4K HDR iPhone-like clip about 4 s, an 8K one about 17 s.
 */
const POSTER_MILLISECONDS = 120_000;
/** Scratch for the one frame ffmpeg writes (at most 1600 × 1600 RGB as PNG). */
const POSTER_SCRATCH_BYTES = 64 * 1024 * 1024;
/** The protocols ffprobe and ffmpeg may open: the link's (http only for the local MinIO) and what https runs on. */
const PROTOCOLS = "http,https,tcp,tls";

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
// What ffmpeg says when it recognised the file as a format other than the two it may open.
const NOT_ALLOWED_FORMAT = /Format not on whitelist/;

/**
 * The text with the presigned link, any piece of it and its host taken out: ffmpeg and ffprobe
 * end their errors with the link they were given ("<link>: Invalid data found…").
 */
function withoutLink(text: string, link: string): string {
  let cleaned = text.split(link).join("the original");
  try {
    const { host, hostname } = new URL(link);
    cleaned = cleaned.split(host).join("R2").split(hostname).join("R2");
  } catch {
    // No host to take out.
  }
  return cleaned.replace(/https?:\/\/\S+/g, "a link").replace(/X-Amz-[A-Za-z-]*=?[^&\s]*/g, "…");
}

/** The last line the tool printed, without the link. */
function lastLineOf(stderr: string, link: string): string {
  return withoutLink(stderr.trim().split("\n").at(-1) ?? "", link);
}

/**
 * What ffprobe or ffmpeg failing on an original means. Every error it returns is new, with no
 * cause, and none says the link:
 * - the file's fault, for good: the tool refused it (`corrupt`, or `unsupported-type` for a format
 *   other than the two allowed), died on it (SIGSEGV, SIGABRT; under the cap a crafted file gets
 *   ENOMEM or no thread, never a SIGKILL) or printed far too much;
 * - anything else retries: R2 or the network failing the read, a SIGKILL from outside (the OOM
 *   killer), the tool running past its time (it reads over the network, so a slow read can't be
 *   told from a slow file), the job ending, the worker stopping, or the tool unable to run.
 * Exported for its test.
 */
export function videoToolFailure(
  tool: "ffprobe" | "ffmpeg",
  error: unknown,
  context: { memoryBytes: number; link: string },
): Error {
  if (!(error instanceof ProcessError)) {
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : "an unknown error";
    return new Error(`${tool} couldn't run: ${name}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  const lastLine = lastLineOf(error.stderrTail, context.link);
  const ending = describeEnding(error);
  if (error.ending === "too-much-output") {
    return new PermanentJobError("corrupt", `${tool} printed far too much reading the video: ${ending}`);
  }
  if (error.ending !== "exit") return new Error(`${tool} didn't finish reading the video: ${ending}`);
  if (toolDidNotRun(error)) return new Error(`${tool} couldn't run: ${ending}: ${lastLine}`);
  if (killedFromOutside(error)) return new Error(`${tool} was killed from outside the worker: ${ending}`);
  if (error.exitCode !== null && NETWORK_TROUBLE.test(error.stderrTail)) {
    return new Error(`${tool} couldn't read the original from R2: ${ending}: ${lastLine}`);
  }
  if (error.exitCode !== null && NOT_ALLOWED_FORMAT.test(error.stderrTail)) {
    const refusal = error.stderrTail.split("\n").find((line) => NOT_ALLOWED_FORMAT.test(line)) ?? lastLine;
    return new PermanentJobError(
      "unsupported-type",
      `The original isn't a video the album takes: ${withoutLink(refusal.trim(), context.link)}`,
    );
  }
  return new PermanentJobError(
    "corrupt",
    `${tool} couldn't read the video, under a ${context.memoryBytes}-byte cap: ${ending}: ${lastLine}`,
  );
}

/** Runs ffprobe or ffmpeg under the memory cap (runCapped), its failure told apart by videoToolFailure. */
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
    });
  } catch (error) {
    throw videoToolFailure(tool, error, { memoryBytes: context.ffmpegMemoryBytes, link: context.link });
  }
}

/** How ffprobe and ffmpeg open the original: over the link only, as a video only, reading only what they must. */
function readingArgs(): string[] {
  return [
    ...["-rw_timeout", String(READ_TIMEOUT_MICROSECONDS)],
    ...["-protocol_whitelist", PROTOCOLS],
    ...["-format_whitelist", VIDEO_DEMUXERS],
    ...["-probesize", String(PROBE_BYTES)],
    ...["-analyzeduration", String(PROBE_MICROSECONDS)],
  ];
}

/** ffprobe's description of the original, checked: a video the album takes, and its facts. */
async function probe(context: VideoContext): Promise<VideoFacts> {
  const args = ["-hide_banner", "-loglevel", "error", ...readingArgs()];
  args.push("-print_format", "json", "-show_entries", PROBE_ENTRIES, context.link);
  const { stdout } = await runVideoTool("ffprobe", args, context, PROBE_MILLISECONDS);
  let description: unknown;
  try {
    description = JSON.parse(stdout);
  } catch {
    throw new PermanentJobError("corrupt", "ffprobe's description of the original isn't JSON");
  }
  const check = videoFactsFrom(description);
  if (!check.ok) throw new PermanentJobError(check.reason, `The original is ${check.found}, not a video the album takes`);
  return check.facts;
}

// Shrunk to fit 1600 px on its long edge, never enlarged: what sharp then shrinks further, and what
// an HDR frame is tone-mapped at (not at its full 4K).
const FIT_VIEW = `scale=w='min(${VIEW.longEdge},iw)':h='min(${VIEW.longEdge},ih)':force_original_aspect_ratio=decrease`;

/**
 * ffmpeg's filters for the poster's frame (no turn among them: see posterArgs). An HDR frame (PQ or
 * HLG) is tone-mapped to SDR: zscale makes it linear light from its own colours (named in
 * video-probe.ts, never taken from the file as text), in BT.709 primaries, tonemap's hable curve
 * brings its highlights into SDR's range, and zscale encodes it as BT.709. Every frame ends as
 * 8-bit RGB for the PNG sharp reads.
 */
function posterFilters(hdr: HdrColours | null): string {
  if (!hdr) return `${FIT_VIEW},format=rgb24`;
  return [
    FIT_VIEW,
    `zscale=tin=${hdr.transfer}:min=${hdr.matrix}:pin=${hdr.primaries}:rin=${hdr.range}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=bt709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=bt709:m=bt709:r=tv",
    "format=yuv420p",
    "format=rgb24",
  ].join(",");
}

/** Where in the video the poster's frame is: min(1 s, half its duration), or its start when it has none. */
function posterSeconds(facts: VideoFacts): number {
  return facts.durationSeconds === null ? 0 : Math.min(POSTER_AT_MOST_SECONDS, Number((facts.durationSeconds / 2).toFixed(3)));
}

/**
 * ffmpeg's arguments for the poster's frame, written as a PNG to `output`.
 * - `-ss` before `-i`: ffmpeg seeks in the container's index and reads from the keyframe before
 *   the frame by range requests, then decodes up to the frame itself (accurate seek, its default).
 * - The frame is turned upright by ffmpeg itself: its autorotate, on unless -noautorotate, turns
 *   each decoded frame by the stream's display matrix before the filters below. So no turn of our
 *   own is added (it would turn a portrait iPhone video twice), and the size the album keeps is the
 *   probe's turned the same way (video-probe.ts).
 * - Its threads are pinned (Ruling R): -threads for decoding and writing, -filter_threads for the
 *   filters. -map_metadata -1: the frame carries none of the file's tags.
 */
function posterArgs(facts: VideoFacts, context: VideoContext, output: string): string[] {
  const threads = String(context.posterThreads);
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin"],
    ...["-filter_threads", String(context.filterThreads)],
    ...readingArgs(),
    ...["-threads", threads, "-ss", String(posterSeconds(facts)), "-i", context.link],
    ...["-map", `0:${facts.streamIndex}`, "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1"],
    ...["-vf", posterFilters(facts.hdr), "-threads", threads],
    ...["-c:v", "png", "-f", "image2", "-update", "1", output],
  ];
}

/** Probes the original and makes its poster's files, in the job's scratch folder. */
async function posterOf(context: VideoContext): Promise<Poster> {
  const probeStartedAt = performance.now();
  const facts = await probe(context);
  const posterStartedAt = performance.now();
  const output = join(context.folder, "poster.png");
  const { stderrTail } = await runVideoTool("ffmpeg", posterArgs(facts, context, output), context, POSTER_MILLISECONDS);
  // ffmpeg exits with 0 having written nothing when the frame isn't there to decode: the file was
  // cut short, unless the read failed on its way.
  const written = await stat(output).then(
    (file) => file.size,
    () => 0,
  );
  if (written === 0) {
    const lastLine = lastLineOf(stderrTail, context.link);
    if (NETWORK_TROUBLE.test(stderrTail)) throw new Error(`ffmpeg couldn't read the original from R2: ${lastLine}`);
    throw new PermanentJobError("corrupt", `ffmpeg found no frame for the poster: ${lastLine}`);
  }
  const stills = await deriveStills({
    path: output,
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
    posterOf({ ...options, link, folder, signal: job.signal }),
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
