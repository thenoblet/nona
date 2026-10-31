import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { readSection } from "@/lib/content/store";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { assignCelebration } from "@/lib/media/celebration";
import { plausibleCaptureTime } from "@/lib/media/capture-time";
import { requestConversion } from "@/lib/media/conversion";
import { findItemToProcess, markVideoReady } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, PLAYBACK_URL_SECONDS, presignGet, putPublicObject } from "@/lib/storage/objects";
import type { JobReport, MediaJob, MediaJobHandler } from "../queues";
import { withScratch } from "../scratch";
import { tooLongToConvert } from "./convert";
import { streamsCopyable, type PlayableJobData } from "./playable";
import { contentHashOf, rewriteManifest, withdrawIfHidden } from "./publishing";
import { deriveStills, VIEW, type Stills } from "./stills";
import { hdrToSdr, sdrInput } from "./video-filters";
import type { VideoFacts } from "./video-probe";
import {
  blameFileFromThirdAttempt,
  ffmpegGlobalArgs,
  probeVideo,
  runVideoTool,
  VIDEO_READING_LIMITS,
  type ReadingArgs,
  type VideoToolRun,
} from "./video-tools";

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
 * every phone can play it as it is. Then, never before its ready mark:
 * - its clean playable copy's job (media.playable, Task 14b) is sent, for a video whose streams an
 *   MP4 carries as they are (H.264 or HEVC, AAC or no sound): the file the album plays an H.264
 *   video from;
 * - a video that can't be played everywhere, or is long and heavy to stream (conversionWanted), is
 *   queued for a backlog conversion (media.convert, Task 11), sent once; one longer than the worker
 *   converts (WORKER_CONVERT_MAX_SECONDS) has its conversion failed, `too-long`, at once, and none
 *   is sent. A conversion an unhide left queued is sent too (Task 12), at priority 20 when a guest
 *   is waiting for it (a highlight, or a phone's ask).
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
/**
 * A video every phone plays is converted only when it is longer than this and its bitrate above
 * HEAVY_BITS_PER_SECOND: a long, heavy original is large to stream, its copy as large.
 */
const LONG_VIDEO_SECONDS = 3 * 60;
/**
 * About 12 Mbit/s (fix round 1): with no cap, CRF 23 makes about 8.7 Mbit/s of a phone's grainy
 * 1080p (measured, Task 14b), so converting a 6 to 9 Mbit/s original saves nothing and costs a
 * generation of quality; above 12, its conversion is clearly smaller.
 */
const HEAVY_BITS_PER_SECOND = 12_000_000;
/** ffprobe and ffmpeg give up on a read or write that makes no progress for this long (in microseconds: 10 s). */
const READ_TIMEOUT_MICROSECONDS = 10_000_000;
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
  /** The longest video converted (WORKER_CONVERT_MAX_SECONDS): a longer one's conversion is failed, `too-long`, and never queued. */
  convertMaxSeconds: number;
};

/** Where and how a job runs ffprobe and ffmpeg: over the presigned link to the original, a credential, never logged. */
type PosterRun = VideoToolRun & { link: string; options: PosterOptions };

/** What the scratch folder's work made. */
type Poster = { facts: VideoFacts; stills: Stills; probeMilliseconds: number; posterMilliseconds: number };

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
function readingArgs(link: string): ReadingArgs {
  return [
    ...["-protocol_whitelist", protocolsFor(link)],
    ...["-rw_timeout", String(READ_TIMEOUT_MICROSECONDS)],
    ...RECONNECTS,
    ...VIDEO_READING_LIMITS,
  ];
}

/**
 * Shrunk to fit 1600 px on its long edge, never enlarged, with even sides: what sharp then shrinks
 * further, and what an HDR frame is tone-mapped at (not at its full 4K). zscale refuses a 4:2:0
 * frame with an odd side ("code 1027"), as 2560 × 1080 fitted to 1600 × 675 would be.
 */
const FIT_VIEW = `scale=w='min(${VIEW.longEdge},iw)':h='min(${VIEW.longEdge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;

/**
 * ffmpeg's filters for the poster's frame (no turn among them: see posterArgs), from the shared
 * video filters (video-filters.ts). Every colour named is one video-probe.ts allowed.
 * - SDR: scale turns YUV into RGB by the matrix and range the probe found, BT.709 when it found
 *   none (ffmpeg notes §2.0, §4.9). The output is RGB, so no output matrix or range is named.
 * - HDR (PQ or HLG): tone-mapped to SDR BT.709 (§4.7).
 * Every frame ends as 8-bit RGB for the PNG sharp reads.
 */
function posterFilters(facts: VideoFacts): string {
  if (!facts.hdr) return `${FIT_VIEW}${sdrInput(facts.sdr)},format=rgb24`;
  return `${FIT_VIEW},${hdrToSdr(facts.hdr)},format=rgb24`;
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
function posterArgs(facts: VideoFacts, run: PosterRun, seconds: number, output: string): string[] {
  const threads = String(run.options.posterThreads);
  return [
    ...ffmpegGlobalArgs(run.options.filterThreads),
    ...readingArgs(run.link),
    ...["-threads", threads, "-ss", String(seconds), "-i", run.link],
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
async function posterFrame(facts: VideoFacts, run: PosterRun): Promise<string> {
  const seconds = posterSeconds(facts);
  const output = join(run.folder, "poster.png");
  await runVideoTool("ffmpeg", posterArgs(facts, run, seconds, output), run, POSTER_MILLISECONDS);
  if ((await sizeOf(output)) > 0) return output;
  if (seconds > 0) {
    const fromStart = join(run.folder, "poster-from-start.png");
    await runVideoTool("ffmpeg", posterArgs(facts, run, 0, fromStart), run, POSTER_MILLISECONDS);
    if ((await sizeOf(fromStart)) > 0) return fromStart;
  }
  throw blameFileFromThirdAttempt("ffmpeg found no frame for the poster", run.retryCount, run.source);
}

/** Probes the original and makes its poster's files, in the job's scratch folder. */
async function posterOf(run: PosterRun): Promise<Poster> {
  const probeStartedAt = performance.now();
  const facts = await probeVideo(readingArgs(run.link), run.link, run, PROBE_MILLISECONDS);
  const posterStartedAt = performance.now();
  const stills = await deriveStills({
    path: await posterFrame(facts, run),
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
 * Whether the video gets an H.264 conversion beside its clean copy (Noblet, Task 14b):
 * - every video a phone can't play as it is (HEVC, HDR, 4K, slow motion, a browser's WebM: its
 *   probe's browserPlayable), always;
 * - an H.264 video every phone plays (within 1920, which browserPlayable requires), only when it is
 *   longer than 3 minutes and its average bitrate (the original's size over its length, sound
 *   included) is above about 12 Mbit/s;
 * - otherwise none: its clean copy is what the album plays.
 * Exported for its test.
 */
export function conversionWanted(facts: Pick<VideoFacts, "browserPlayable" | "durationSeconds">, originalBytes: number): boolean {
  if (!facts.browserPlayable) return true;
  const seconds = facts.durationSeconds;
  if (seconds === null || seconds <= LONG_VIDEO_SECONDS) return false;
  return (originalBytes * 8) / seconds > HEAVY_BITS_PER_SECOND;
}

/**
 * Sends the video's clean copy's job (media.playable) once it is ready, naming the generation its
 * files are for (sweeper step 5 tells a job of this generation from an earlier one's by it). Never
 * throws: a copy whose job can't be sent leaves the video ready with its poster (and its
 * conversion, where it has one), and the sweeper's step 5 sends it within 10 minutes; the failure
 * is logged, with ids only.
 */
async function sendPlayableCopy(mediaId: string, generation: number, options: PosterOptions): Promise<void> {
  try {
    const data: PlayableJobData = { mediaId, generation };
    await (await options.jobQueue()).send(MEDIA_QUEUES.playable, data);
  } catch (error) {
    console.error(`[worker] media.poster media=${mediaId} is ready, but its playable copy's job wasn't sent:`, describeError(error));
  }
}

/**
 * Sends the video's conversion (media.convert): to the backlog, or at priority 20 when a guest is
 * waiting for it (a phone asked, or the couple made it a highlight, before it was ready or before an
 * unhide made its poster again). Never throws: the row says `queued`, so if this fails the sweeper
 * sends it within its next sweep, at the same priority.
 */
async function sendConversion(mediaId: string, onDemand: boolean, options: PosterOptions): Promise<void> {
  try {
    await requestConversion(mediaId, onDemand ? CONVERT_PRIORITY.onDemand : CONVERT_PRIORITY.backlog, options.jobQueue);
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
    posterOf({
      memoryBytes: options.ffmpegMemoryBytes,
      signal: job.signal,
      folder,
      retryCount: job.retryCount,
      // A guest is waiting for the poster: the worker's own priority, never behind a conversion.
      priority: "foreground",
      source: "link",
      redact: { link, as: "the original" },
      link,
      options,
    }),
  );
  const { facts, stills } = poster;
  console.log(
    `[worker] media.poster job=${job.id} media=${mediaId}: probed in ${poster.probeMilliseconds} ms, poster in ${poster.posterMilliseconds} ms`,
  );
  // A time from a reset or wrong clock counts as none: the file's, then the phone's, then the upload's.
  const capturedAt =
    plausibleCaptureTime(facts.capturedAt, item.startedAt) ?? plausibleCaptureTime(item.capturedAt, item.startedAt);
  const { value: celebrations } = await readSection("celebrations");
  const contentHash = contentHashOf(original.etag, `poster-settings-${POSTER_SETTINGS_VERSION}`, item.derivedGeneration);
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
    derivedGeneration: item.derivedGeneration,
    width: facts.width,
    height: facts.height,
    thumbhash: stills.placeholder.thumbhash,
    averageColor: stills.placeholder.averageColor,
    capturedAt,
    celebration: assignCelebration(capturedAt, item.startedAt, celebrations),
    durationSeconds: facts.durationSeconds,
    videoCodec: facts.codec,
    browserPlayable: facts.browserPlayable,
    needsConversion: conversionWanted(facts, original.size),
    // Too long, or too many frames for its length (Ruling BG): failed, `too-long`, at once, and never queued.
    tooLongToConvert: tooLongToConvert(facts.durationSeconds, facts.framesPerSecond, options.convertMaxSeconds),
  });
  if (!marked) {
    await withdrawIfHidden(job.queue, mediaId, [keys["poster-thumb"], keys["poster-view"]], {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: item.derivedGeneration,
    });
    return;
  }
  if (streamsCopyable(facts)) await sendPlayableCopy(mediaId, item.derivedGeneration, options);
  if (marked.conversionQueued) await sendConversion(mediaId, marked.conversionOnDemand, options);
  await rewriteManifest(job.queue, mediaId, marked.manifest, job.signal);
  return { sizeBytes: original.size, kind: `video/${facts.codec}${facts.hdr ? "-hdr" : ""}` };
}

/** media.poster's handler, with the worker's settings. */
export function posterHandler(options: PosterOptions): MediaJobHandler {
  return (job) => processVideo(job, options);
}
