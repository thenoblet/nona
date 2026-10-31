import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as zod from "zod";
import { describeError } from "@/lib/log-error";
import { conversionLeaseOf } from "@/lib/media/conversion";
import { claimConversion, markConversionDone, releaseConversion } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import type { X264Cap, X264Preset } from "../config";
import { PermanentJobError, RetriedJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { contentHashOf, rewriteManifest, withdrawIfHidden, type JobQueue } from "./publishing";
import { convertedPictureFilters } from "./video-filters";
import type { VideoFacts } from "./video-probe";
import {
  blameFileFromThirdAttempt,
  ffmpegGlobalArgs,
  probeVideo,
  runVideoTool,
  SCRATCH_FILE_READING,
  ToolTimeoutError,
  type VideoToolRun,
} from "./video-tools";

/*
 * media.convert: a version of a video that every phone plays, H.264 High in MP4 within 1080p. Its
 * jobs come at two priorities (Task 8's two workers): 20, which the on-demand worker takes at once
 * (a guest's phone couldn't play the original, or the couple made it a highlight), and below 20,
 * the backlog's, which its worker takes only while the admin's convert_backlog switch is on.
 *
 * A job (the command follows the ffmpeg notes, §2.3, Rulings AM and AN):
 * 1. claims the conversion (Ruling AG): only a ready, visible video whose conversion is `queued`
 *    (or, for a retry, the `converting` its own attempt left) is converted; a late or second job,
 *    such as the backlog's after an on-demand one finished, does nothing;
 * 2. streams the original into its scratch folder, which must have twice the original's size free
 *    (the MP4's faststart pass rewrites the output in place: notes §4.13), under the job's signal;
 * 3. probes it there, and converts it, nice'd, on pinned threads and under its own memory cap
 *    (WORKER_CONVERT_MEMORY_BYTES): fitted within 1920 × 1080 whichever way up, HDR tone-mapped to
 *    SDR BT.709, at most 30 fps, CRF 23 (capped only where WORKER_X264_MAXRATE is set), AAC
 *    stereo, no metadata but its capture time, `moov` first. One that starts while no other
 *    conversion runs in this worker takes every CPU (WORKER_CPUS) for its decoder and x264; one
 *    that starts beside another, the shared counts (Task 14b);
 * 4. checks what ffmpeg made, since exiting 0 isn't success (notes §4.17): H.264 High, 8-bit 4:2:0,
 *    as long as the original's video, with its audio;
 * 5. puts it in the public bucket under a content hash, marks the conversion `done` with its key,
 *    and writes the item's manifest again.
 * Scratch is removed however the job ends. A conversion that fails and will be retried goes back to
 * `queued`; one that fails for good is marked `failed` by media.dead (markConversionFailed), and
 * the video keeps its poster. A video hidden while it converts publishes nothing: its file comes
 * down, and media.visibility is queued to purge it (withdrawIfHidden).
 */

/**
 * Part of every converted file's key. Raise it whenever what this job makes changes (the size, the
 * quality, the colours), so the files made again get new keys, which no cache has seen. 2: Task
 * 14b's threads and optional cap (whose values join the key too: conversionSettings).
 */
const CONVERT_SETTINGS_VERSION = 2;
/** The box a converted video fits within, either way up (Android's 1080p, notes §4.19). */
const FIT = { longEdge: 1920, shortEdge: 1080 };
/** -fpsmax: 60 fps and slow motion come out at 30, which keeps x264's level at 4.0 for 1080p (notes §4.19). */
const MAX_FRAMES_PER_SECOND = 30;
/** x264's constant rate factor: its default quality, the brief's. */
const CRF = 23;
const AUDIO_BITRATE = "128k";
/** What the converted video may differ from the original's by in length (notes §2.3, §4.17). */
const DURATION_TOLERANCE_SECONDS = 0.5;
/** ffprobe reads only a file's index and a few MB, from the scratch disk. */
const PROBE_MILLISECONDS = 60_000;
/**
 * ffmpeg's time for a conversion, from the video's length. Measured in the worker image under
 * --cpus=3, at the defaults (decoder and x264 on 2 threads, filters on 1), one conversion alone,
 * on grainy clips at a phone's bitrate, on a host whose speed varied about twofold between runs:
 * 4K HEVC HLG takes 1.0 to 3.1 s a second of video (an iPhone's portrait turn, done on the full
 * 4K frame, adds up to 40%), 8K HEVC 1.4 to 3.4 s, 1080p60 H.264 0.4 to 1.0 s; Task 14b's 1080p
 * HLG with a phone's detail, 1.5 to 2.6 s. Ten seconds a second of 30 fps video is about four times
 * the slowest, room for the second conversion and the photos sharing those CPUs, scaled by the
 * frame rate as the CPU time is (frameRateFactor); ten minutes more for a short clip's start.
 * Never past three hours, so the download, the upload and the rest fit inside the job's four
 * (media.convert's expireInSeconds, 14,400).
 */
const CONVERT_SECONDS_PER_VIDEO_SECOND = 10;
const CONVERT_BASE_MILLISECONDS = 10 * 60_000;
const CONVERT_MAX_MILLISECONDS = 3 * 60 * 60_000;
/**
 * The conversion's CPU time (prlimit --cpu: user and system time, all of ffmpeg's threads), from
 * the video's length and frame rate (Ruling AR). Measured in the worker image (Task 14b), a 30 fps
 * HEVC HLG conversion with a phone's detail costs 4.4 to 5.2 CPU-seconds a second of video on a
 * quiet host, and 6.2 to 7.8 on a busy one (threads sharing cores run slower); the first real one
 * in production, 4.9. Thirty a second is about four times the busy host's costliest; decoding grows
 * with the frames read, so 60 fps gets twice that and 240 fps slow motion eight times (x264 encodes
 * at most 30, -fpsmax). Ten minutes more for a short clip's start. Only a file that makes ffmpeg
 * work several times harder than any phone's runs out.
 */
const CONVERT_CPU_SECONDS_PER_VIDEO_SECOND = 30;
const CONVERT_CPU_BASE_SECONDS = 10 * 60;
/** The frame rate both budgets are for: a faster video gets more in proportion (frameRateFactor). */
const BUDGET_FRAMES_PER_SECOND = 30;
/**
 * The most frames a second either budget counts, or the frame-count limit (tooLongToConvert) does:
 * a phone's slow motion. A file says its own frame rate, and a crafted one can say 90000/1 or more,
 * which would otherwise make every budget endless (Ruling BG).
 */
const MAX_COUNTED_FRAMES_PER_SECOND = 240;
/**
 * The most frames a converted video's original may hold, per second of WORKER_CONVERT_MAX_SECONDS:
 * at its 1,800, 108,000, a 30-minute video at 60 fps, or 7½ minutes of 240 fps slow motion.
 */
const MAX_FRAMES_PER_CONVERTED_SECOND = 60;
/** A conversion's wall-clock time-outs in a row that fail it for good, `too-slow` (Ruling BH). */
const TIME_OUTS_FOR_GOOD = 3;
/** Scratch beyond twice the original: a small original can come out bigger at CRF 23. */
const SCRATCH_MARGIN_BYTES = 256 * 1024 * 1024;

/** What the job takes from the worker's settings. */
export type ConvertOptions = {
  /** The memory (address space) the conversion's ffmpeg may take: WORKER_CONVERT_MEMORY_BYTES. */
  convertMemoryBytes: number;
  /** The memory ffprobe may take, as for a poster's: WORKER_FFMPEG_MEMORY_BYTES. */
  ffmpegMemoryBytes: number;
  /** ffmpeg's -threads before -i, decoding the original, beside another conversion: WORKER_FFMPEG_DECODER_THREADS. */
  decoderThreads: number;
  /** ffmpeg's -threads after -i, x264's, beside another conversion: WORKER_X264_THREADS. */
  x264Threads: number;
  /** ffmpeg's -filter_threads (fitting, tone-mapping): WORKER_FFMPEG_FILTER_THREADS. */
  filterThreads: number;
  /** The container's CPUs, a lone conversion's decoder and x264 threads: WORKER_CPUS. */
  cpus: number;
  /** x264's -preset: WORKER_X264_PRESET. */
  x264Preset: X264Preset;
  /** x264's -maxrate:v and -bufsize:v, WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE; null (the default) for none: pure CRF 23. */
  x264Cap: X264Cap | null;
  /** The longest video converted, in seconds: WORKER_CONVERT_MAX_SECONDS. */
  convertMaxSeconds: number;
  /** The job queue a withdrawal is sent to, for a video hidden while it converted. */
  jobQueue: JobQueue;
};

/** The threads a conversion's ffmpeg runs on: its decoder's (-threads before -i), its filters' and x264's. */
export type ConversionThreads = { decoder: number; x264: number; filter: number };

/** What a conversion in the scratch folder made. */
type Conversion = {
  facts: VideoFacts;
  threads: ConversionThreads;
  outputBytes: number;
  downloadMilliseconds: number;
  convertMilliseconds: number;
  uploadMilliseconds: number;
};

/**
 * ffmpeg's arguments for the conversion (ffmpeg notes §2.3), in the job's scratch folder:
 * - the original opened as a file only, by one of the two video demuxers (§2.0);
 * - -threads before -i is the decoder's, which would otherwise take the host's CPUs (§4.14), and
 *   after it x264's (conversionThreads);
 * - -map by the probe's indexes: the video and one audio stream, never an iPhone's metadata tracks
 *   or a second video (§2.3); no turn of our own, as autorotate turns the frames upright (§4.1);
 * - -map_metadata -1 and -map_chapters -1 drop every tag, location included (the `©xyz` and `loci`
 *   atoms, Apple's location key), and only the capture time is written back: the default mapping
 *   would drop creation_time and keep the location (§4.12);
 * - CRF 23, uncapped unless WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE are set: then -maxrate:v
 *   and -bufsize:v hold its peaks to the cap over the buffer (the notes' optional "capped CRF",
 *   §2.3; x264 still picks level 4.0). Off by default (Noblet): a cap costs quality in exactly the
 *   scenes that matter, dancing, confetti, low light, grain;
 * - -profile:v high, and no -level: x264 picks the lowest that fits, 4.0 for 1080p30; a 10-bit
 *   frame reaching x264 fails the run rather than making High 10, which most phones can't play
 *   (§4.8, §4.19);
 * - +faststart writes the `moov` before the `mdat`, so a phone starts playing before it has it all;
 *   its second pass needs a regular file, not a pipe (§4.13).
 */
export function convertArgs(
  facts: Pick<VideoFacts, "streamIndex" | "audioStreamIndex" | "hdr" | "sdr">,
  paths: { original: string; output: string },
  threads: ConversionThreads,
  options: Pick<ConvertOptions, "x264Preset" | "x264Cap">,
  capturedAt: Date | null,
): string[] {
  const audio = facts.audioStreamIndex;
  return [
    ...ffmpegGlobalArgs(threads.filter),
    ...SCRATCH_FILE_READING,
    ...["-threads", String(threads.decoder), "-i", paths.original],
    ...["-map", `0:${facts.streamIndex}`, ...(audio === null ? [] : ["-map", `0:${audio}`])],
    ...["-map_metadata", "-1", "-map_chapters", "-1"],
    ...["-vf", convertedPictureFilters(facts, FIT.longEdge, FIT.shortEdge)],
    ...["-fpsmax", String(MAX_FRAMES_PER_SECOND)],
    ...["-c:v", "libx264", "-preset", options.x264Preset, "-crf", String(CRF)],
    ...(options.x264Cap === null ? [] : ["-maxrate:v", options.x264Cap.maxRate, "-bufsize:v", options.x264Cap.bufferSize]),
    ...["-profile:v", "high"],
    ...["-threads", String(threads.x264)],
    // The native AAC encoder at a constant 128 kbit/s, stereo: Android's recommended audio (§2.3).
    ...(audio === null ? [] : ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2"]),
    // ISO 8601, which ffmpeg stores in mvhd, tkhd and mdhd to the second (§2.3).
    ...(capturedAt === null ? [] : ["-metadata", `creation_time=${capturedAt.toISOString()}`]),
    ...["-movflags", "+faststart", "-f", "mp4", paths.output],
  ];
}

/**
 * The settings a converted file's key is made from: the version, and the cap when one is set, so
 * turning the cap on (or changing it) gives the files made after it keys of their own.
 */
export function conversionSettings(options: Pick<ConvertOptions, "x264Cap">): string {
  const cap = options.x264Cap;
  return `convert-settings-${CONVERT_SETTINGS_VERSION}${cap === null ? "" : `-maxrate-${cap.maxRate}-bufsize-${cap.bufferSize}`}`;
}

/** Conversions whose ffmpeg runs now in this worker: the on-demand and the backlog workers' together. */
let conversionsRunning = 0;

/**
 * The threads of a conversion that starts while `othersRunning` other conversions run in this
 * worker (Noblet, Task 14b). Alone, its decoder and x264 take every CPU the container has
 * (WORKER_CPUS): the first real conversion (81 s of 1080 × 1920 HLG) used about 2.4 of 3 CPUs on
 * two each. Beside another, the shared counts, WORKER_FFMPEG_DECODER_THREADS and
 * WORKER_X264_THREADS, two each. Decided once, as it starts: a lone conversion keeps its threads
 * when a second starts beside it, nice'd as both are. Every count is from the settings, never the
 * machine's (Ruling R).
 */
export function conversionThreads(
  othersRunning: number,
  options: Pick<ConvertOptions, "cpus" | "decoderThreads" | "x264Threads" | "filterThreads">,
): ConversionThreads {
  if (othersRunning === 0) return { decoder: options.cpus, x264: options.cpus, filter: options.filterThreads };
  return { decoder: options.decoderThreads, x264: options.x264Threads, filter: options.filterThreads };
}

/**
 * Runs `convert` on the threads conversionThreads gives it, counted among the conversions running
 * while it runs.
 */
async function withConversionThreads<TResult>(
  options: ConvertOptions,
  convert: (threads: ConversionThreads) => Promise<TResult>,
): Promise<TResult> {
  const threads = conversionThreads(conversionsRunning, options);
  conversionsRunning += 1;
  try {
    return await convert(threads);
  } finally {
    conversionsRunning -= 1;
  }
}

/** A frame rate as the budgets and limits count it: the file's, at most 240; 30 when it doesn't say (Ruling BG). */
function countedFramesPerSecond(framesPerSecond: number | null): number {
  // No rate, or nonsense (none, zero or less), is 30's; any rate past 240, infinite included, is 240's.
  if (framesPerSecond === null || Number.isNaN(framesPerSecond) || framesPerSecond <= 0) return BUDGET_FRAMES_PER_SECOND;
  return Math.min(framesPerSecond, MAX_COUNTED_FRAMES_PER_SECOND);
}

/** How much more time and CPU than 30 fps's a video's frames take to decode: from 1 to 8 (240 fps). */
function frameRateFactor(framesPerSecond: number | null): number {
  return Math.max(1, countedFramesPerSecond(framesPerSecond) / BUDGET_FRAMES_PER_SECOND);
}

/**
 * Whether a video is too long to convert, `too-long` at once with no job (Rulings AR, BG): longer
 * than WORKER_CONVERT_MAX_SECONDS, or holding more frames than 60 a second of it (its length times
 * its frame rate, counted at most 240): 7½ minutes of slow motion is as much work as half an hour
 * at 60 fps. A video of no known length isn't, here: its conversion checks the file's own.
 */
export function tooLongToConvert(durationSeconds: number | null, framesPerSecond: number | null, maxSeconds: number): boolean {
  if (durationSeconds === null) return false;
  return durationSeconds > maxSeconds || durationSeconds * countedFramesPerSecond(framesPerSecond) > maxSeconds * MAX_FRAMES_PER_CONVERTED_SECOND;
}

/**
 * How long ffmpeg may take over a video this long at this frame rate (or of no known length: the
 * most), ten minutes and ten seconds a second of video times frameRateFactor, never past three
 * hours. A busy box can't be told from a slow file by the clock, so running past it is retried,
 * but its third time in a row is for good, `too-slow` (Ruling BH): the couple can retry it.
 */
export function conversionMilliseconds(durationSeconds: number | null, framesPerSecond: number | null): number {
  if (durationSeconds === null) return CONVERT_MAX_MILLISECONDS;
  const perVideoSecond = CONVERT_SECONDS_PER_VIDEO_SECOND * 1000 * frameRateFactor(framesPerSecond);
  return Math.min(CONVERT_MAX_MILLISECONDS, CONVERT_BASE_MILLISECONDS + durationSeconds * perVideoSecond);
}

/**
 * How much CPU time ffmpeg may use over a video this long at this frame rate, all its threads
 * together (prlimit --cpu, Ruling AR): ten minutes and 30 CPU-seconds a second of video, times
 * frameRateFactor (the frame rate over 30, counted from 30 to 240: Ruling BG). A video of no known
 * length gets the longest's; of no known frame rate, 30 fps's. Waiting for a CPU doesn't count, so however busy the box (at nice 19 a conversion
 * may get a sliver of one), only a file that makes ffmpeg work far harder than any phone's runs
 * out: that is the file's fault, blamed from the third attempt.
 */
export function conversionCpuSeconds(durationSeconds: number | null, framesPerSecond: number | null, maxSeconds: number): number {
  const perVideoSecond = CONVERT_CPU_SECONDS_PER_VIDEO_SECOND * frameRateFactor(framesPerSecond);
  return Math.ceil(CONVERT_CPU_BASE_SECONDS + (durationSeconds ?? maxSeconds) * perVideoSecond);
}

/** What ffprobe is asked of the converted file. */
const OUTPUT_ENTRIES = "format=duration:stream=codec_type,codec_name,profile,pix_fmt,width,height,duration";

const text = zod.string().optional();
const outputSchema = zod.object({
  format: zod.object({ duration: text }).optional(),
  streams: zod.array(
    zod.object({
      codec_type: text,
      codec_name: text,
      profile: text,
      pix_fmt: text,
      width: zod.number().int().optional(),
      height: zod.number().int().optional(),
      duration: text,
    }),
  ),
});

/** A duration ffprobe gave, or null for none or nonsense. */
function seconds(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * The length the converted video must have: the original's video stream's, compared with the
 * converted video stream's, when ffprobe gave the original's stream one (MP4, MOV); otherwise the
 * original's container's, compared with the converted file's container (Matroska and WebM give
 * only the container's). Null when neither is known (a browser's WebM recording).
 */
export type ExpectedLength = { streamSeconds: number | null; containerSeconds: number | null };

/**
 * What is wrong with the converted file, from ffprobe's JSON (OUTPUT_ENTRIES), or null when it is
 * what the album serves (ffmpeg notes §2.3, §4.17): one H.264 video stream, profile High, 8-bit
 * 4:2:0, within the box with even sides; an AAC stream when the original had audio; and as long as
 * the original, within half a second, like compared with like (ExpectedLength). Exported for its test.
 */
export function outputProblem(probeJson: unknown, expected: { length: ExpectedLength; audio: boolean }): string | null {
  const parsed = outputSchema.safeParse(probeJson);
  if (!parsed.success) return "ffprobe couldn't describe the converted file";
  const { streams, format } = parsed.data;
  const videos = streams.filter((stream) => stream.codec_type === "video");
  if (videos.length !== 1) return `the converted file has ${videos.length} video streams, not one`;
  const [video] = videos;
  if (video.codec_name !== "h264") return `the converted video is ${video.codec_name ?? "of no codec"}, not H.264`;
  if (video.profile !== "High") return `the converted video's profile is ${video.profile ?? "unknown"}, not High`;
  if (video.pix_fmt !== "yuv420p") return `the converted video is ${video.pix_fmt ?? "of no pixel format"}, not yuv420p`;
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  const fits = Math.max(width, height) <= FIT.longEdge && Math.min(width, height) <= FIT.shortEdge;
  if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0 || !fits) {
    return `the converted video is ${width} × ${height}, not even-sided within ${FIT.longEdge} × ${FIT.shortEdge}`;
  }
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (expected.audio && (audios.length !== 1 || audios[0].codec_name !== "aac")) {
    return "the converted file has no AAC audio, though the original had audio";
  }
  return lengthProblem("the converted", expected.length, { video: video.duration, file: format?.duration });
}

/**
 * What is wrong with the length of a file made from the original (its conversion, or its clean
 * copy), whose description starts `subject` ("the converted"): within half a second of the
 * original's, like compared with like (ExpectedLength), or null when it is. A file that ends early
 * is what ffmpeg makes of an original cut short that still passes ffprobe (ffmpeg notes §4.17).
 */
export function lengthProblem(
  subject: string,
  expected: ExpectedLength,
  made: { video: string | undefined; file: string | undefined },
): string | null {
  const { streamSeconds, containerSeconds } = expected;
  const [what, originalSeconds, madeSeconds] =
    streamSeconds !== null ? ["video", streamSeconds, seconds(made.video)] : ["file", containerSeconds, seconds(made.file)];
  if (originalSeconds === null) return null;
  if (madeSeconds === null) return `${subject} ${what} has no duration`;
  if (Math.abs(madeSeconds - originalSeconds) > DURATION_TOLERANCE_SECONDS) {
    return `${subject} ${what} is ${madeSeconds.toFixed(2)} s long, the original's ${originalSeconds.toFixed(2)} s`;
  }
  return null;
}

/** What a file made from the original has its length checked against, from the original's probe (lengthProblem). */
export function expectedLength(facts: Pick<VideoFacts, "videoStreamSeconds" | "durationSeconds">): ExpectedLength {
  // facts.durationSeconds is the container's, or the stream's when the container gave none.
  return facts.videoStreamSeconds !== null
    ? { streamSeconds: facts.videoStreamSeconds, containerSeconds: null }
    : { streamSeconds: null, containerSeconds: facts.durationSeconds };
}

/**
 * Checks ffmpeg's output: there, not empty, and what outputProblem wants. A problem is the file's
 * from the third attempt (an original that ends early, such as an upload cut short that still
 * passes ffprobe, comes out short every time), the worker's before it.
 */
async function checkOutput(output: string, facts: VideoFacts, run: VideoToolRun): Promise<number> {
  const bytes = await stat(output).then(
    (file) => file.size,
    () => 0,
  );
  if (bytes === 0) throw blameFileFromThirdAttempt("ffmpeg exited 0 but wrote nothing", run.retryCount, run.source);
  const { stdout } = await runVideoTool(
    "ffprobe",
    ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov"]
      .concat(["-print_format", "json", "-show_error", "-show_entries", OUTPUT_ENTRIES, output]),
    run,
    PROBE_MILLISECONDS,
  );
  let description: unknown = null;
  try {
    description = JSON.parse(stdout);
  } catch {
    // outputProblem says so.
  }
  const problem = outputProblem(description, { length: expectedLength(facts), audio: facts.audioStreamIndex !== null });
  if (problem) throw blameFileFromThirdAttempt(`ffmpeg exited 0, but ${problem}`, run.retryCount, run.source);
  return bytes;
}

/** A video too long to convert (tooLongToConvert): its conversion fails for good, `too-long`, with no retries. */
function tooLong(
  durationSeconds: number | null,
  framesPerSecond: number | null,
  options: Pick<ConvertOptions, "convertMaxSeconds">,
): PermanentJobError | null {
  if (durationSeconds === null || !tooLongToConvert(durationSeconds, framesPerSecond, options.convertMaxSeconds)) return null;
  const frames = Math.round(durationSeconds * countedFramesPerSecond(framesPerSecond));
  return new PermanentJobError(
    "too-long",
    `The video is ${Math.round(durationSeconds)} s long, ${frames} frames counted at its frame rate (at most 240), past the ` +
      `${options.convertMaxSeconds} s and ${options.convertMaxSeconds * MAX_FRAMES_PER_CONVERTED_SECOND} frames the worker converts`,
  );
}

/**
 * A conversion's failure, its wall-clock time-outs counted in a row (Ruling BH): one is retried,
 * leaving its count in the job's output for the next attempt (RetriedJobError); the third in a row
 * fails it for good, `too-slow`, as a runaway file would otherwise hold a conversion's slot for its
 * thirteen attempts' time-outs. Its video stays ready with its poster and copy, and the couple can
 * retry it (retryProcessing). Any other failure leaves no count, so it starts again from one.
 */
function withTimeOutsCounted(error: unknown, job: MediaJob): unknown {
  if (!(error instanceof ToolTimeoutError)) return error;
  const before = Number(job.previousOutput?.consecutiveTimeouts ?? 0);
  const timeOuts = (Number.isInteger(before) && before > 0 ? before : 0) + 1;
  if (timeOuts >= TIME_OUTS_FOR_GOOD) {
    return new PermanentJobError("too-slow", `${error.message}, ${timeOuts} time-outs in a row`);
  }
  return new RetriedJobError(`${error.message} (time-out ${timeOuts} in a row; the third fails it as too-slow)`, {
    consecutiveTimeouts: timeOuts,
  });
}

/** Downloads, probes, converts, checks and uploads, in the job's scratch folder. */
async function convertIn(
  folder: string,
  job: MediaJob,
  originalKey: string,
  videoKey: string,
  capturedAt: Date | null,
  options: ConvertOptions,
): Promise<Conversion> {
  const run: VideoToolRun = {
    memoryBytes: options.ffmpegMemoryBytes,
    signal: job.signal,
    folder,
    retryCount: job.retryCount,
    // A conversion takes only the CPU that photos and posters leave (nice 19).
    priority: "background",
    source: "scratch",
  };
  const paths = { original: join(folder, "original"), output: join(folder, "converted.mp4") };

  const downloadStartedAt = performance.now();
  await saveOriginal(originalKey, paths.original, job.signal);
  const convertStartedAt = performance.now();
  const facts = await probeVideo(SCRATCH_FILE_READING, paths.original, run, PROBE_MILLISECONDS);
  // Its own length and frame rate, read from the file itself, decide: the row's could be a poster's from a file since replaced.
  const refusal = tooLong(facts.durationSeconds, facts.framesPerSecond, options);
  if (refusal) throw refusal;
  const threads = await withConversionThreads(options, async (threads) => {
    try {
      await runVideoTool(
        "ffmpeg",
        convertArgs(facts, paths, threads, options, capturedAt),
        {
          ...run,
          memoryBytes: options.convertMemoryBytes,
          cpuSeconds: conversionCpuSeconds(facts.durationSeconds, facts.framesPerSecond, options.convertMaxSeconds),
        },
        conversionMilliseconds(facts.durationSeconds, facts.framesPerSecond),
      );
    } catch (error) {
      throw withTimeOutsCounted(error, job);
    }
    return threads;
  });
  const outputBytes = await checkOutput(paths.output, facts, run);
  const uploadStartedAt = performance.now();
  const converted = createReadStream(paths.output);
  try {
    await putPublicObject(videoKey, converted, "video/mp4", { signal: job.signal });
  } finally {
    converted.destroy();
  }
  return {
    facts,
    threads,
    outputBytes,
    downloadMilliseconds: Math.round(convertStartedAt - downloadStartedAt),
    convertMilliseconds: Math.round(uploadStartedAt - convertStartedAt),
    uploadMilliseconds: Math.round(performance.now() - uploadStartedAt),
  };
}

/**
 * media.convert's work for one job, whose data is `{ mediaId }` (and `leaseJobId` for a held job's
 * copy). It works under its lease (Ruling AQ): it claims the conversion, or carries on the one its
 * own earlier attempt claimed; any other job finds nothing to do. A failure leaves the conversion
 * `converting` under the lease: a retry carries it on, and a failure for good has media.dead mark
 * it failed. Only a video hidden while it converted gives the lease up, back to `queued`.
 */
export async function convertVideo(job: MediaJob, options: ConvertOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const lease = conversionLeaseOf(job);
  const item = await claimConversion(mediaId, lease);
  if (!item) {
    console.log(
      `[worker] media.convert job=${job.id}: nothing to do, the conversion is done, failed, under another job's lease, or not wanted (the item hidden, deleted or not ready)`,
    );
    return;
  }
  // Past the longest the worker converts: failed at once, before any download (the poster's probe
  // said so; the row keeps no frame rate, so the file's is checked once probed).
  const refusal = tooLong(item.durationSeconds, null, options);
  if (refusal) throw refusal;
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);
  const contentHash = contentHashOf(original.etag, conversionSettings(options), item.derivedGeneration);
  const videoKey = derivedKey(mediaId, contentHash, "video", "mp4");

  const conversion = await withScratch(2 * original.size + SCRATCH_MARGIN_BYTES, (folder) =>
    convertIn(folder, job, item.originalKey, videoKey, item.capturedAt, options),
  );
  const { facts } = conversion;
  const videoSeconds = facts.videoStreamSeconds ?? facts.durationSeconds;
  // The real conversion speed, for the couple's status page (spec §8.3): ids, sizes and times only.
  const length = videoSeconds === null ? "a video of unknown length" : `${videoSeconds.toFixed(1)} s of video`;
  const speed = videoSeconds ? ` (${(conversion.convertMilliseconds / 1000 / videoSeconds).toFixed(2)} s a second of video)` : "";
  const { threads } = conversion;
  console.log(
    `[worker] media.convert job=${job.id} media=${mediaId}: downloaded in ${conversion.downloadMilliseconds} ms, ` +
      `converted ${length} in ${conversion.convertMilliseconds} ms${speed} to ${conversion.outputBytes} bytes ` +
      `(threads: decoder ${threads.decoder}, filters ${threads.filter}, x264 ${threads.x264}), ` +
      `uploaded in ${conversion.uploadMilliseconds} ms`,
  );

  const manifest = await markConversionDone(mediaId, lease, videoKey);
  if (!manifest) {
    // Hidden or deleted while it converted: the lease goes, so an unhide finds it queued, and the file comes down.
    try {
      await releaseConversion(mediaId, lease);
    } catch (error) {
      console.error(`[worker] media.convert media=${mediaId} couldn't be put back to queued:`, describeError(error));
    }
    await withdrawIfHidden(job.queue, mediaId, [videoKey], {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: item.derivedGeneration,
    });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind: `video/${facts.codec}${facts.hdr ? "-hdr" : ""}` };
}

/** media.convert's handler, with the worker's settings: both its on-demand and its backlog workers run it. */
export function convertHandler(options: ConvertOptions): MediaJobHandler {
  return (job) => convertVideo(job, options);
}
