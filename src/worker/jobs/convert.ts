import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as zod from "zod";
import { describeError } from "@/lib/log-error";
import { conversionLeaseOf } from "@/lib/media/conversion";
import { claimConversion, markConversionDone, releaseConversion } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import type { X264Preset } from "../config";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
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
 *    SDR BT.709, at most 30 fps, AAC stereo, no metadata but its capture time, `moov` first;
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
 * quality, the colours), so the files made again get new keys, which no cache has seen.
 */
const CONVERT_SETTINGS_VERSION = 1;
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
 * 4K frame, adds up to 40%), 8K HEVC 1.4 to 3.4 s, 1080p60 H.264 0.4 to 1.0 s. Ten seconds a second
 * is three times the slowest, room for the second conversion and the photos sharing those CPUs;
 * ten minutes more for a short clip's start. Never past three hours, so the download, the upload
 * and the rest fit inside the job's four (media.convert's expireInSeconds, 14,400).
 */
const CONVERT_SECONDS_PER_VIDEO_SECOND = 10;
const CONVERT_BASE_MILLISECONDS = 10 * 60_000;
const CONVERT_MAX_MILLISECONDS = 3 * 60 * 60_000;
/**
 * The conversion's CPU time (prlimit --cpu: user and system time, all of ffmpeg's threads), from
 * the video's length (Ruling AR). Measured in the worker image at the defaults, three runs each, on
 * grainy clips at a phone's bitrate: 8K HEVC 3.0 to 3.2 CPU-seconds a second of video, an iPhone's
 * portrait 4K HEVC HLG 3.4 (the costliest), 1080p60 H.264 1.1. Three times the costliest, rounded
 * up, plus ten minutes for a short clip's start: a phone's video never comes near it, even on a CPU
 * a third as fast per second.
 */
const CONVERT_CPU_SECONDS_PER_VIDEO_SECOND = 10;
const CONVERT_CPU_BASE_SECONDS = 10 * 60;
/** Scratch beyond twice the original: a small original can come out bigger at CRF 23. */
const SCRATCH_MARGIN_BYTES = 256 * 1024 * 1024;

/** What the job takes from the worker's settings. */
export type ConvertOptions = {
  /** The memory (address space) the conversion's ffmpeg may take: WORKER_CONVERT_MEMORY_BYTES. */
  convertMemoryBytes: number;
  /** The memory ffprobe may take, as for a poster's: WORKER_FFMPEG_MEMORY_BYTES. */
  ffmpegMemoryBytes: number;
  /** ffmpeg's -threads before -i, decoding the original: WORKER_FFMPEG_DECODER_THREADS. */
  decoderThreads: number;
  /** ffmpeg's -threads after -i, x264's: WORKER_X264_THREADS. */
  x264Threads: number;
  /** ffmpeg's -filter_threads (fitting, tone-mapping): WORKER_FFMPEG_FILTER_THREADS. */
  filterThreads: number;
  /** x264's -preset: WORKER_X264_PRESET. */
  x264Preset: X264Preset;
  /** The longest video converted, in seconds: WORKER_CONVERT_MAX_SECONDS. */
  convertMaxSeconds: number;
  /** The job queue a withdrawal is sent to, for a video hidden while it converted. */
  jobQueue: JobQueue;
};

/** What a conversion in the scratch folder made. */
type Conversion = {
  facts: VideoFacts;
  outputBytes: number;
  downloadMilliseconds: number;
  convertMilliseconds: number;
  uploadMilliseconds: number;
};

/**
 * ffmpeg's arguments for the conversion (ffmpeg notes §2.3), in the job's scratch folder:
 * - the original opened as a file only, by one of the two video demuxers (§2.0);
 * - -threads before -i is the decoder's, which would otherwise take the host's CPUs (§4.14), and
 *   after it x264's;
 * - -map by the probe's indexes: the video and one audio stream, never an iPhone's metadata tracks
 *   or a second video (§2.3); no turn of our own, as autorotate turns the frames upright (§4.1);
 * - -map_metadata -1 and -map_chapters -1 drop every tag, location included (the `©xyz` and `loci`
 *   atoms, Apple's location key), and only the capture time is written back: the default mapping
 *   would drop creation_time and keep the location (§4.12);
 * - -profile:v high, and no -level: x264 picks the lowest that fits, 4.0 for 1080p30; a 10-bit
 *   frame reaching x264 fails the run rather than making High 10, which most phones can't play
 *   (§4.8, §4.19);
 * - +faststart writes the `moov` before the `mdat`, so a phone starts playing before it has it all;
 *   its second pass needs a regular file, not a pipe (§4.13).
 */
export function convertArgs(
  facts: Pick<VideoFacts, "streamIndex" | "audioStreamIndex" | "hdr" | "sdr">,
  paths: { original: string; output: string },
  options: Pick<ConvertOptions, "decoderThreads" | "x264Threads" | "filterThreads" | "x264Preset">,
  capturedAt: Date | null,
): string[] {
  const audio = facts.audioStreamIndex;
  return [
    ...ffmpegGlobalArgs(options.filterThreads),
    ...SCRATCH_FILE_READING,
    ...["-threads", String(options.decoderThreads), "-i", paths.original],
    ...["-map", `0:${facts.streamIndex}`, ...(audio === null ? [] : ["-map", `0:${audio}`])],
    ...["-map_metadata", "-1", "-map_chapters", "-1"],
    ...["-vf", convertedPictureFilters(facts, FIT.longEdge, FIT.shortEdge)],
    ...["-fpsmax", String(MAX_FRAMES_PER_SECOND)],
    ...["-c:v", "libx264", "-preset", options.x264Preset, "-crf", String(CRF), "-profile:v", "high"],
    ...["-threads", String(options.x264Threads)],
    // The native AAC encoder at a constant 128 kbit/s, stereo: Android's recommended audio (§2.3).
    ...(audio === null ? [] : ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2"]),
    // ISO 8601, which ffmpeg stores in mvhd, tkhd and mdhd to the second (§2.3).
    ...(capturedAt === null ? [] : ["-metadata", `creation_time=${capturedAt.toISOString()}`]),
    ...["-movflags", "+faststart", "-f", "mp4", paths.output],
  ];
}

/**
 * How long ffmpeg may take over a video this long (or of no known length: the most). Running past
 * it is retried: a busy box can't be told from a slow file by the clock (Ruling AR).
 */
export function conversionMilliseconds(durationSeconds: number | null): number {
  if (durationSeconds === null) return CONVERT_MAX_MILLISECONDS;
  return Math.min(CONVERT_MAX_MILLISECONDS, CONVERT_BASE_MILLISECONDS + durationSeconds * CONVERT_SECONDS_PER_VIDEO_SECOND * 1000);
}

/**
 * How much CPU time ffmpeg may use over a video this long, all its threads together (prlimit
 * --cpu, Ruling AR); a video of no known length gets the longest's. Waiting for a CPU doesn't
 * count, so however busy the box (at nice 19 a conversion may get a sliver of one), only a file
 * that makes ffmpeg work far harder than any phone's runs out: that is the file's fault, blamed from
 * the third attempt.
 */
export function conversionCpuSeconds(durationSeconds: number | null, maxSeconds: number): number {
  return Math.ceil(CONVERT_CPU_BASE_SECONDS + (durationSeconds ?? maxSeconds) * CONVERT_CPU_SECONDS_PER_VIDEO_SECOND);
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
  const { streamSeconds, containerSeconds } = expected.length;
  const [what, originalSeconds, madeSeconds] =
    streamSeconds !== null
      ? ["video", streamSeconds, seconds(video.duration)]
      : ["file", containerSeconds, seconds(format?.duration)];
  if (originalSeconds !== null) {
    if (madeSeconds === null) return `the converted ${what} has no duration`;
    if (Math.abs(madeSeconds - originalSeconds) > DURATION_TOLERANCE_SECONDS) {
      return `the converted ${what} is ${madeSeconds.toFixed(2)} s long, the original's ${originalSeconds.toFixed(2)} s`;
    }
  }
  return null;
}

/** What the converted file's length is checked against, from the original's probe (outputProblem). */
function expectedLength(facts: VideoFacts): ExpectedLength {
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

/** A video longer than the worker converts: its conversion fails for good, `too-long`, with no retries (Ruling AR). */
function tooLong(durationSeconds: number | null, options: Pick<ConvertOptions, "convertMaxSeconds">): PermanentJobError | null {
  if (durationSeconds === null || durationSeconds <= options.convertMaxSeconds) return null;
  return new PermanentJobError(
    "too-long",
    `The video is ${Math.round(durationSeconds)} s long, past the ${options.convertMaxSeconds} s the worker converts`,
  );
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
  // Its own length, read from the file itself, decides: the row's could be a poster's from a file since replaced.
  const refusal = tooLong(facts.durationSeconds, options);
  if (refusal) throw refusal;
  await runVideoTool(
    "ffmpeg",
    convertArgs(facts, paths, options, capturedAt),
    {
      ...run,
      memoryBytes: options.convertMemoryBytes,
      cpuSeconds: conversionCpuSeconds(facts.durationSeconds, options.convertMaxSeconds),
    },
    conversionMilliseconds(facts.durationSeconds),
  );
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
  // Past the longest the worker converts: failed at once, before any download (the poster's probe said so).
  const refusal = tooLong(item.durationSeconds, options);
  if (refusal) throw refusal;
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);
  const contentHash = contentHashOf(original.etag, `convert-settings-${CONVERT_SETTINGS_VERSION}`, item.derivedGeneration);
  const videoKey = derivedKey(mediaId, contentHash, "video", "mp4");

  const conversion = await withScratch(2 * original.size + SCRATCH_MARGIN_BYTES, (folder) =>
    convertIn(folder, job, item.originalKey, videoKey, item.capturedAt, options),
  );
  const { facts } = conversion;
  const videoSeconds = facts.videoStreamSeconds ?? facts.durationSeconds;
  // The real conversion speed, for the couple's status page (spec §8.3): ids, sizes and times only.
  const length = videoSeconds === null ? "a video of unknown length" : `${videoSeconds.toFixed(1)} s of video`;
  const speed = videoSeconds ? ` (${(conversion.convertMilliseconds / 1000 / videoSeconds).toFixed(2)} s a second of video)` : "";
  console.log(
    `[worker] media.convert job=${job.id} media=${mediaId}: downloaded in ${conversion.downloadMilliseconds} ms, ` +
      `converted ${length} in ${conversion.convertMilliseconds} ms${speed} to ${conversion.outputBytes} bytes, ` +
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
    await withdrawIfHidden(job.queue, mediaId, [videoKey], { signal: job.signal, jobQueue: options.jobQueue });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind: `video/${facts.codec}${facts.hdr ? "-hdr" : ""}` };
}

/** media.convert's handler, with the worker's settings: both its on-demand and its backlog workers run it. */
export function convertHandler(options: ConvertOptions): MediaJobHandler {
  return (job) => convertVideo(job, options);
}
