import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as zod from "zod";
import { WISH_SECONDS } from "@/lib/media/limits";
import { findWishToProcess, markWishReady, type WishToProcess } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import type { X264Preset } from "../config";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { conversionCpuSeconds, conversionMilliseconds } from "./convert";
import { containerProblem } from "./playable";
import { contentHashOf, rewriteManifest, withdrawIfHidden, type JobQueue } from "./publishing";
import { deriveStills, VIEW, type Stills } from "./stills";
import { convertedPictureFilters } from "./video-filters";
import type { VideoFacts } from "./video-probe";
import {
  blameFileFromThirdAttempt,
  ffmpegGlobalArgs,
  probeVideo,
  readingLimits,
  runVideoTool,
  SCRATCH_FILE_READING,
  type VideoToolRun,
} from "./video-tools";

/*
 * media.wish (Task 16): a voice or video wish's recording made into what the wishes wall plays.
 * Ruling CE: it is queued only once a wish names the recording (addWish, after its response; the
 * sweeper, for one whose job was lost; an unhide), never when the upload completes, so a recording
 * whose wish never comes (an orphan) is never made into public files: its original stays private.
 * The commands follow the ffmpeg notes, §2.4 and §2.5, binding (Ruling BS). A job:
 * 1. finds an uploaded, visible recording that a wish (not deleted) names (Ruling AG): anything else,
 *    an orphan or a second delivery included, does nothing;
 * 2. streams the original into its scratch folder, and probes it there (layer 3 of the type checks):
 *    - a voice note must have sound and no moving picture, in one of the containers a phone's
 *      recorder writes (MP4/M4A/3GP, WebM, Ogg, WAV, MP3, AAC, AMR); its cover art, if any, is left;
 *    - a video message must be a video the album would take (video-probe.ts);
 *    anything else fails for good, `unsupported-type`, which only its sender sees;
 * 3. converts it, nice'd, under a memory cap and a CPU budget, from the scratch file only, with no
 *    metadata at all (-map_metadata -1, so no location):
 *    - voice: its sound as AAC at 96 kbit/s in an M4A (-f ipod), trimmed to 60 s;
 *    - video: H.264 High within 1280 × 720 whichever way up, HDR (an iPhone's HLG, from the
 *      fallback's camera) tone-mapped to SDR BT.709, at most 30 fps, CRF 23, AAC 96 kbit/s stereo,
 *      trimmed to 30 s, `moov` first;
 * 4. checks what ffmpeg made, since exiting 0 isn't success (§4.17), and reads the length the wall
 *    shows from the file made (a browser's WebM says none of its own, §4.15);
 * 5. for a video message, takes a poster from the file made (already upright, SDR and small), as a
 *    WebP viewing size and thumbnail with its ThumbHash;
 * 6. puts every file in the public bucket under one content hash, cached for good, marks the
 *    recording `ready` while it is still visible and in the same generation, and writes its
 *    manifest. One hidden (or unhidden into a new generation) meanwhile publishes nothing: its
 *    files come down, recorded for media.visibility (withdrawIfHidden), which a hide's job deletes
 *    with the rest of the item's folder; an unhide queues this job again, for new keys.
 * A failure for good is marked by media.dead (failed, with its reason); the wall then tells its
 * sender, and only them (Ruling BR). Logs carry ids and facts about the file only.
 */

/**
 * Part of every wish file's key. Raise it whenever what this job makes changes (a bitrate, a size,
 * the poster), so the files made again get new keys, which no cache has seen.
 */
const WISH_SETTINGS_VERSION = 1;
/** The demuxers a voice note may be read with (ffmpeg notes §2.0): every container a phone's recorder writes. */
export const VOICE_DEMUXERS = "mov,matroska,ogg,wav,mp3,aac,amr";
/** How ffprobe and ffmpeg open a voice note in the scratch folder: as a file, by those demuxers only. */
const VOICE_FILE_READING = ["-protocol_whitelist", "file", ...readingLimits(VOICE_DEMUXERS)];
/** A voice note's AAC, and a video message's: speech at 96 kbit/s (the brief's). */
const AUDIO_BITRATE = "96k";
/** The box a video message fits within, either way up: 720p. */
const VIDEO_FIT = { longEdge: 1280, shortEdge: 720 };
/** -fpsmax: a phone's 60 fps comes out at 30 (notes §4.19). */
const MAX_FRAMES_PER_SECOND = 30;
/** x264's constant rate factor, as a conversion's. */
const CRF = 23;
/** How far past its limit a file made may run: AAC's priming (a 60 s voice note comes out 60.007 s, notes §2.4). */
const PAST_LIMIT_SECONDS = 0.1;
/** How far a file made may fall short of the original's length (or the limit), as a conversion's (notes §4.17). */
const SHORT_BY_SECONDS = 0.5;
/** ffprobe reads only a file's index and a few MB, from the scratch disk. */
const PROBE_MILLISECONDS = 60_000;
/** A minute of speech decodes and encodes in a second or two; this is room for a busy box. */
const VOICE_MILLISECONDS = 5 * 60_000;
/** Its CPU time: AAC has no threads, and a minute of Opus or AAC takes about 2 CPU-seconds. */
const VOICE_CPU_SECONDS = 120;
/** The poster's frame decodes from the made file's keyframe: under a second. */
const POSTER_MILLISECONDS = 60_000;
/** The poster's frame is at most this far in, as a video's in the album. */
const POSTER_AT_MOST_SECONDS = 1;
/** Scratch beyond twice the original: the made file (faststart moves its `moov` in place) and the poster. */
const SCRATCH_MARGIN_BYTES = 128 * 1024 * 1024;
/** A codec's name as ffmpeg gives it: anything else is never stored or logged. */
const CODEC_NAME = /^[a-z0-9_]{1,32}$/;

/** What the job takes from the worker's settings. */
export type WishOptions = {
  /** The memory (address space) a video message's conversion may take: WORKER_CONVERT_MEMORY_BYTES. */
  convertMemoryBytes: number;
  /** The memory ffprobe, a voice note's ffmpeg and the poster's may take: WORKER_FFMPEG_MEMORY_BYTES. */
  ffmpegMemoryBytes: number;
  /** ffmpeg's -threads before -i, the decoder's: WORKER_FFMPEG_DECODER_THREADS. */
  decoderThreads: number;
  /** ffmpeg's -threads after -i, x264's: WORKER_X264_THREADS. */
  x264Threads: number;
  /** ffmpeg's -filter_threads (fitting, tone-mapping): WORKER_FFMPEG_FILTER_THREADS. */
  filterThreads: number;
  /** x264's -preset: WORKER_X264_PRESET. */
  x264Preset: X264Preset;
  /** The longest video the worker converts (WORKER_CONVERT_MAX_SECONDS): the CPU budget of a file of no known length. */
  convertMaxSeconds: number;
  /** The job queue a withdrawal is sent to, for a recording hidden while it was made. */
  jobQueue: JobQueue;
};

/** A voice note's facts, from its probe. */
export type VoiceFacts = {
  /** The sound stream kept: AAC first, then the default, then the first. */
  audioStreamIndex: number;
  audioCodec: string;
  /** The file's length, when it says (a browser's WebM doesn't). */
  durationSeconds: number | null;
  /**
   * Whether that length is only ffprobe's estimate from the bitrate (an MP3, AMR or raw AAC file has
   * no index to say), too rough to hold the made file to: only its limit is checked then.
   */
  durationEstimated: boolean;
};

export type VoiceCheck =
  | { ok: true; facts: VoiceFacts }
  | { ok: false; reason: "unsupported-type" | "corrupt"; found: string };

/** What ffprobe is asked of a voice note: its streams, what they are, and its length. No tag, so no location, is read. */
const VOICE_PROBE_ENTRIES =
  "format=format_name,duration:stream=index,codec_type,codec_name,duration:stream_disposition=default,attached_pic,still_image,timed_thumbnails";

const text = zod.string().optional();
const voiceProbeSchema = zod.object({
  format: zod.object({ format_name: text, duration: text }).optional(),
  streams: zod.array(
    zod.object({
      index: zod.number().int().min(0),
      codec_type: text,
      codec_name: text,
      duration: text,
      disposition: zod.record(zod.string(), zod.number()).optional(),
    }),
  ),
});

type VoiceStream = zod.infer<typeof voiceProbeSchema>["streams"][number];

/** A length ffprobe gave ("12.500000"), or null for none or nonsense. */
function seconds(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The containers whose length ffprobe estimates from the bitrate: no index says it (ffmpeg's mp3, amr and aac demuxers). */
const ESTIMATED_LENGTH_FORMATS = new Set(["mp3", "amr", "aac"]);

/** A moving picture: a video stream that isn't cover art, a still image or a track of thumbnails. */
function isMotionVideo(stream: VoiceStream): boolean {
  const disposition = stream.disposition ?? {};
  return stream.codec_type === "video" && !disposition.attached_pic && !disposition.still_image && !disposition.timed_thumbnails;
}

/**
 * What ffprobe's JSON (VOICE_PROBE_ENTRIES) says of a voice note: one the wall takes, with the sound
 * to keep, or why not (global constraints, layer 3: "a voice wish must contain an audio stream and
 * no video"). Cover art (an MP3's picture) isn't video: the sound alone is mapped. Exported for its test.
 */
export function voiceFactsFrom(probeJson: unknown): VoiceCheck {
  const parsed = voiceProbeSchema.safeParse(probeJson);
  if (!parsed.success) return { ok: false, reason: "corrupt", found: "a file ffprobe couldn't describe" };
  const { streams, format } = parsed.data;
  if (streams.some(isMotionVideo)) return { ok: false, reason: "unsupported-type", found: "a recording with a moving picture" };
  const sounds = streams.filter((stream) => stream.codec_type === "audio" && CODEC_NAME.test(stream.codec_name ?? ""));
  if (sounds.length === 0) return { ok: false, reason: "unsupported-type", found: "a file with no sound" };
  const aac = sounds.filter((stream) => stream.codec_name === "aac");
  const candidates = aac.length > 0 ? aac : sounds;
  const sound = candidates.find((stream) => stream.disposition?.default) ?? candidates[0];
  return {
    ok: true,
    facts: {
      audioStreamIndex: sound.index,
      audioCodec: sound.codec_name as string,
      durationSeconds: seconds(format?.duration) ?? seconds(sound.duration),
      durationEstimated: ESTIMATED_LENGTH_FORMATS.has(format?.format_name ?? ""),
    },
  };
}

/**
 * ffmpeg's arguments for a voice note (ffmpeg notes §2.4): opened as a file only, by the voice
 * demuxers; its one sound stream, nothing else (-vn -sn -dn: no cover art, subtitle or data); no
 * metadata at all; stopped once the output reaches 60 s (-t after -i counts the output's own
 * timeline, which works on a WebM that says no length and doesn't start at 0, §4.15); AAC at
 * 96 kbit/s; an M4A (ipod: MP4 with audio only, its `M4A ` brand), `moov` first.
 */
export function voiceArgs(audioStreamIndex: number, paths: { original: string; output: string }): string[] {
  return [
    // No filters run: one filter thread is never started.
    ...ffmpegGlobalArgs(1),
    ...VOICE_FILE_READING,
    ...["-threads", "1", "-i", paths.original],
    ...["-map", `0:${audioStreamIndex}`, "-vn", "-sn", "-dn"],
    ...["-map_metadata", "-1", "-map_chapters", "-1"],
    ...["-t", String(WISH_SECONDS.voice)],
    ...["-c:a", "aac", "-b:a", AUDIO_BITRATE],
    ...["-movflags", "+faststart", "-f", "ipod", paths.output],
  ];
}

/** What a video message's conversion runs on: its decoder's, filters' and x264's threads, and x264's preset. */
export type VideoWishSettings = Pick<WishOptions, "decoderThreads" | "x264Threads" | "filterThreads" | "x264Preset">;

/**
 * ffmpeg's arguments for a video message (ffmpeg notes §2.5), in the job's scratch folder: the
 * decoder's threads before -i (else the host's CPUs, §4.14) and x264's after; the probe's video and
 * sound only (never an iPhone's metadata tracks); no metadata at all (§4.12); stopped at 30 s of
 * output; fitted within 1280 × 720 whichever way up, HDR tone-mapped to SDR BT.709, SDR converted
 * and tagged BT.709, HDR side data deleted (video-filters.ts), never turned by hand (autorotate
 * has turned each frame upright, §4.1); at most 30 fps; H.264 High at CRF 23, failing rather
 * than making High 10 (§4.8); AAC 96 kbit/s stereo; `moov` first (§4.13).
 */
export function videoWishArgs(
  facts: Pick<VideoFacts, "streamIndex" | "audioStreamIndex" | "hdr" | "sdr">,
  paths: { original: string; output: string },
  settings: VideoWishSettings,
): string[] {
  const audio = facts.audioStreamIndex;
  return [
    ...ffmpegGlobalArgs(settings.filterThreads),
    ...SCRATCH_FILE_READING,
    ...["-threads", String(settings.decoderThreads), "-i", paths.original],
    ...["-map", `0:${facts.streamIndex}`, ...(audio === null ? [] : ["-map", `0:${audio}`])],
    ...["-map_metadata", "-1", "-map_chapters", "-1"],
    ...["-t", String(WISH_SECONDS.video)],
    ...["-vf", convertedPictureFilters(facts, VIDEO_FIT.longEdge, VIDEO_FIT.shortEdge)],
    ...["-fpsmax", String(MAX_FRAMES_PER_SECOND)],
    ...["-c:v", "libx264", "-preset", settings.x264Preset, "-crf", String(CRF), "-profile:v", "high"],
    ...["-threads", String(settings.x264Threads)],
    ...(audio === null ? [] : ["-c:a", "aac", "-b:a", AUDIO_BITRATE, "-ac", "2"]),
    ...["-movflags", "+faststart", "-f", "mp4", paths.output],
  ];
}

/** What ffprobe is asked of a file made: its streams, their picture, colours, turn and length, and its brand. */
const MADE_ENTRIES =
  "format=duration:format_tags=major_brand:stream=codec_type,codec_name,profile,pix_fmt,width,height,duration,avg_frame_rate,color_transfer:stream_side_data_list";

const madeSchema = zod.object({
  format: zod.object({ duration: text, tags: zod.record(zod.string(), zod.string()).optional() }).optional(),
  streams: zod.array(
    zod.object({
      codec_type: text,
      codec_name: text,
      profile: text,
      pix_fmt: text,
      width: zod.number().int().optional(),
      height: zod.number().int().optional(),
      duration: text,
      avg_frame_rate: text,
      color_transfer: text,
      side_data_list: zod.array(zod.record(zod.string(), zod.unknown())).optional(),
    }),
  ),
});

/**
 * What is wrong with a length made of a recording with this limit, or null: no longer than the
 * limit (and a little AAC priming), and no shorter than the original (or the limit, for a longer
 * one) by more than half a second, which is what an original cut short makes (§4.17). An original
 * of no known length (a browser's WebM) can only be checked against the limit.
 */
function lengthProblem(madeSeconds: number | null, originalSeconds: number | null, limitSeconds: number): string | null {
  if (madeSeconds === null) return "it has no length";
  if (madeSeconds > limitSeconds + PAST_LIMIT_SECONDS) return `it is ${madeSeconds.toFixed(2)} s long, past the ${limitSeconds} s limit`;
  if (originalSeconds !== null) {
    const expected = Math.min(originalSeconds, limitSeconds);
    if (madeSeconds < expected - SHORT_BY_SECONDS) {
      return `it is ${madeSeconds.toFixed(2)} s long, the original's ${expected.toFixed(2)} s`;
    }
  }
  return null;
}

/**
 * What is wrong with the M4A made of a voice note, from ffprobe's JSON (MADE_ENTRIES), or null when
 * it is what the wall plays: one AAC stream and nothing else, an M4A (its `M4A ` brand), and a length
 * lengthProblem passes. Exported for its test.
 */
export function voiceProblem(probeJson: unknown, originalSeconds: number | null): string | null {
  const parsed = madeSchema.safeParse(probeJson);
  if (!parsed.success) return "ffprobe couldn't describe the voice note made";
  const { streams, format } = parsed.data;
  if (streams.some((stream) => stream.codec_type !== "audio")) return "the voice note made carries a picture or another stream";
  if (streams.length !== 1 || streams[0].codec_name !== "aac") return "the voice note made has no AAC sound, or more than one stream";
  if (format?.tags?.major_brand?.trim() !== "M4A") return `the voice note made is branded ${format?.tags?.major_brand ?? "nothing"}, not M4A`;
  const problem = lengthProblem(seconds(format?.duration) ?? seconds(streams[0].duration), originalSeconds, WISH_SECONDS.voice);
  return problem === null ? null : `the voice note made: ${problem}`;
}

/** Frames a second from ffprobe's "30/1", or null when it doesn't say. */
function framesPerSecond(value: string | undefined): number | null {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * What is wrong with the MP4 made of a video message, from ffprobe's JSON (MADE_ENTRIES), or null
 * when it is what the wall plays: one H.264 High 8-bit 4:2:0 video, even-sided within 1280 × 720
 * either way up, upright in its pixels (no display matrix left) and SDR BT.709 (no HDR side data),
 * at most 30 fps; its AAC when the original had sound; and a length lengthProblem passes. Exported
 * for its test.
 */
export function videoWishProblem(probeJson: unknown, expected: { audio: boolean; originalSeconds: number | null }): string | null {
  const parsed = madeSchema.safeParse(probeJson);
  if (!parsed.success) return "ffprobe couldn't describe the video message made";
  const { streams, format } = parsed.data;
  const videos = streams.filter((stream) => stream.codec_type === "video");
  if (videos.length !== 1) return `the video message made has ${videos.length} video streams, not one`;
  const [video] = videos;
  if (video.codec_name !== "h264") return `the video message made is ${video.codec_name ?? "of no codec"}, not H.264`;
  if (video.profile !== "High") return `the video message made is ${video.profile ?? "of no profile"}, not High`;
  if (video.pix_fmt !== "yuv420p") return `the video message made is ${video.pix_fmt ?? "of no pixel format"}, not yuv420p`;
  const width = video.width ?? 0;
  const height = video.height ?? 0;
  const fits = Math.max(width, height) <= VIDEO_FIT.longEdge && Math.min(width, height) <= VIDEO_FIT.shortEdge;
  if (width < 2 || height < 2 || width % 2 !== 0 || height % 2 !== 0 || !fits) {
    return `the video message made is ${width} × ${height}, not even-sided within ${VIDEO_FIT.longEdge} × ${VIDEO_FIT.shortEdge}`;
  }
  if ((video.side_data_list ?? []).length > 0) return "the video message made still has a turn or HDR side data for a player to obey";
  if (video.color_transfer !== "bt709") return `the video message made is ${video.color_transfer ?? "untagged"}, not BT.709`;
  const rate = framesPerSecond(video.avg_frame_rate);
  if (rate !== null && rate > MAX_FRAMES_PER_SECOND + 0.5) return `the video message made has ${Math.round(rate)} frames a second, past 30`;
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (expected.audio && (audios.length !== 1 || audios[0].codec_name !== "aac")) return "the video message made has no AAC sound, though the original had";
  const problem = lengthProblem(seconds(video.duration) ?? seconds(format?.duration), expected.originalSeconds, WISH_SECONDS.video);
  return problem === null ? null : `the video message made: ${problem}`;
}

/** What a job made in its scratch folder, ready to publish. */
type Made = {
  /** The voice note's M4A or the video message's MP4, in the scratch folder. */
  path: string;
  durationSeconds: number;
  /** A video message's poster, and its probe; null for a voice note. */
  poster: Stills | null;
  video: { width: number; height: number; codec: string; hdr: boolean } | null;
  /** The voice note's own codec. */
  audioCodec: string | null;
  convertMilliseconds: number;
};

/** The size of what ffmpeg wrote, 0 when it wrote nothing. */
async function sizeOf(path: string): Promise<number> {
  return stat(path).then(
    (file) => file.size,
    () => 0,
  );
}

/** ffprobe's JSON of a file made, from the scratch disk (an MP4 or M4A: the mov demuxer only). */
async function probeMade(path: string, run: VideoToolRun): Promise<unknown> {
  const { stdout } = await runVideoTool(
    "ffprobe",
    ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov"]
      .concat(["-print_format", "json", "-show_error", "-show_entries", MADE_ENTRIES, path]),
    run,
    PROBE_MILLISECONDS,
  );
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The length of a file made, which the check passed: the stream's, else the container's. */
function madeSeconds(description: unknown): number {
  const parsed = madeSchema.safeParse(description);
  if (!parsed.success) return 0;
  const stream = parsed.data.streams.find((candidate) => candidate.codec_type === "video") ?? parsed.data.streams[0];
  return seconds(stream?.duration) ?? seconds(parsed.data.format?.duration) ?? 0;
}

/**
 * Probes a voice note and makes its M4A. The probe's refusals stand at once: what ffprobe read is
 * the file's own header, so no stall of the worker makes it describe another file.
 */
async function makeVoice(paths: { original: string; output: string }, run: VideoToolRun): Promise<Made> {
  const { stdout } = await runVideoTool(
    "ffprobe",
    ["-hide_banner", "-loglevel", "error", ...VOICE_FILE_READING]
      .concat(["-print_format", "json", "-show_error", "-show_entries", VOICE_PROBE_ENTRIES, paths.original]),
    run,
    PROBE_MILLISECONDS,
  );
  let description: unknown;
  try {
    description = JSON.parse(stdout);
  } catch {
    throw blameFileFromThirdAttempt("ffprobe's description of the recording isn't JSON", run.retryCount, run.source);
  }
  const check = voiceFactsFrom(description);
  if (!check.ok) throw new PermanentJobError(check.reason, `The recording is ${check.found}, not a voice note the wall takes`);
  const startedAt = performance.now();
  await runVideoTool("ffmpeg", voiceArgs(check.facts.audioStreamIndex, paths), { ...run, cpuSeconds: VOICE_CPU_SECONDS }, VOICE_MILLISECONDS);
  const convertMilliseconds = Math.round(performance.now() - startedAt);
  if ((await sizeOf(paths.output)) === 0) throw blameFileFromThirdAttempt("ffmpeg exited 0 but wrote nothing", run.retryCount, run.source);
  const made = await probeMade(paths.output, run);
  // An estimated length can be seconds out on a variable-bitrate MP3: then only the limit is checked
  // (-xerror already fails a file cut short as it is read).
  const originalSeconds = check.facts.durationEstimated ? null : check.facts.durationSeconds;
  const problem = voiceProblem(made, originalSeconds) ?? (await containerProblem(paths.output));
  if (problem) throw blameFileFromThirdAttempt(`ffmpeg exited 0, but ${problem}`, run.retryCount, run.source);
  return {
    path: paths.output,
    durationSeconds: madeSeconds(made),
    poster: null,
    video: null,
    audioCodec: check.facts.audioCodec,
    convertMilliseconds,
  };
}

/**
 * The poster's frame of a video message, from the file made: at min(1 s, half its length), or its
 * start when nothing is there (a clip of a frame or two, notes §4.17). The file made is SDR BT.709,
 * upright and within 720p, so it is read as BT.709 into RGB, with no fitting or tone-mapping.
 */
async function posterOf(video: string, lengthSeconds: number, folder: string, run: VideoToolRun): Promise<Stills> {
  const frame = async (at: number, name: string) => {
    const output = join(folder, name);
    await runVideoTool(
      "ffmpeg",
      [
        ...ffmpegGlobalArgs(1),
        ...["-protocol_whitelist", "file", "-format_whitelist", "mov"],
        ...["-threads", "1", "-ss", String(at), "-i", video],
        ...["-map", "0:v:0", "-frames:v", "1", "-an", "-sn", "-dn", "-map_metadata", "-1"],
        ...["-vf", "scale=in_color_matrix=bt709:in_range=tv,format=rgb24", "-threads", "1"],
        ...["-c:v", "png", "-f", "image2", "-update", "1", output],
      ],
      run,
      POSTER_MILLISECONDS,
    );
    return (await sizeOf(output)) > 0 ? output : null;
  };
  const at = Math.min(POSTER_AT_MOST_SECONDS, Number((lengthSeconds / 2).toFixed(3)));
  const path = (await frame(at, "poster.png")) ?? (at > 0 ? await frame(0, "poster-from-start.png") : null);
  if (!path) throw blameFileFromThirdAttempt("ffmpeg found no frame for the video message's poster", run.retryCount, run.source);
  return deriveStills({ path, maxPixels: VIEW.longEdge * VIEW.longEdge, autoOrient: false, kind: "poster" });
}

/** Probes a video message, converts it, checks it and takes its poster. */
async function makeVideo(paths: { original: string; output: string }, folder: string, run: VideoToolRun, options: WishOptions): Promise<Made> {
  const facts = await probeVideo(SCRATCH_FILE_READING, paths.original, run, PROBE_MILLISECONDS);
  // Its budgets are for what it converts: at most 30 s, whatever the original's length.
  const length = Math.min(facts.videoStreamSeconds ?? facts.durationSeconds ?? WISH_SECONDS.video, WISH_SECONDS.video);
  const startedAt = performance.now();
  await runVideoTool(
    "ffmpeg",
    videoWishArgs(facts, paths, options),
    {
      ...run,
      memoryBytes: options.convertMemoryBytes,
      cpuSeconds: conversionCpuSeconds(length, facts.framesPerSecond, options.convertMaxSeconds),
    },
    conversionMilliseconds(length, facts.framesPerSecond),
  );
  const convertMilliseconds = Math.round(performance.now() - startedAt);
  if ((await sizeOf(paths.output)) === 0) throw blameFileFromThirdAttempt("ffmpeg exited 0 but wrote nothing", run.retryCount, run.source);
  const made = await probeMade(paths.output, run);
  const problem =
    videoWishProblem(made, { audio: facts.audioStreamIndex !== null, originalSeconds: facts.videoStreamSeconds ?? facts.durationSeconds }) ??
    (await containerProblem(paths.output));
  if (problem) throw blameFileFromThirdAttempt(`ffmpeg exited 0, but ${problem}`, run.retryCount, run.source);
  const durationSeconds = madeSeconds(made);
  const poster = await posterOf(paths.output, durationSeconds, folder, run);
  return {
    path: paths.output,
    durationSeconds,
    poster,
    video: { width: poster.width, height: poster.height, codec: facts.codec, hdr: facts.hdr !== null },
    audioCodec: null,
    convertMilliseconds,
  };
}

/** The keys a recording's files go under, by one content hash. */
function keysFor(item: WishToProcess, contentHash: string): Record<"audio", string> | Record<"video" | "poster-thumb" | "poster-view", string> {
  if (item.kind === "audio") return { audio: derivedKey(item.id, contentHash, "audio", "m4a") };
  return {
    video: derivedKey(item.id, contentHash, "video", "mp4"),
    "poster-thumb": derivedKey(item.id, contentHash, "poster-thumb", "webp"),
    "poster-view": derivedKey(item.id, contentHash, "poster-view", "webp"),
  };
}

/** Puts what was made in the public bucket under its keys: the recording streamed from scratch, the poster from memory. */
async function publish(made: Made, keys: Record<string, string>, signal: AbortSignal): Promise<void> {
  const file = createReadStream(made.path);
  try {
    if (keys.audio) await putPublicObject(keys.audio, file, "audio/mp4", { signal });
    else await putPublicObject(keys.video, file, "video/mp4", { signal });
  } finally {
    file.destroy();
  }
  if (made.poster) {
    await putPublicObject(keys["poster-thumb"], made.poster.thumb, "image/webp", { signal });
    await putPublicObject(keys["poster-view"], made.poster.view, "image/webp", { signal });
  }
}

/** media.wish's work for one job, whose data is `{ mediaId }`. */
export async function processWish(job: MediaJob, options: WishOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const item = await findWishToProcess(mediaId);
  if (!item) {
    console.log(
      `[worker] media.wish job=${job.id}: nothing to do, the recording is no longer uploaded, hidden or deleted, or no wish names it`,
    );
    return;
  }
  if (item.kind !== "audio" && item.kind !== "video") {
    throw new PermanentJobError("unsupported-type", `A wish's recording is a ${item.kind}, not a voice note or a video message`);
  }
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);
  const contentHash = contentHashOf(original.etag, `wish-settings-${WISH_SETTINGS_VERSION}`, item.derivedGeneration);
  const keys: Record<string, string> = keysFor(item, contentHash);

  const startedAt = performance.now();
  const made = await withScratch(2 * original.size + SCRATCH_MARGIN_BYTES, async (folder) => {
    const run: VideoToolRun = {
      memoryBytes: options.ffmpegMemoryBytes,
      signal: job.signal,
      folder,
      retryCount: job.retryCount,
      // The notes' background priority (§2.4): a photo or a poster a guest waits for goes first.
      priority: "background",
      source: "scratch",
      subject: item.kind === "audio" ? "the voice note" : "the video message",
    };
    const paths = { original: join(folder, "original"), output: join(folder, item.kind === "audio" ? "wish.m4a" : "wish.mp4") };
    await saveOriginal(item.originalKey, paths.original, job.signal);
    const result = item.kind === "audio" ? await makeVoice(paths, run) : await makeVideo(paths, folder, run, options);
    await publish(result, keys, job.signal);
    return result;
  });
  const kind = made.video ? `wish/video-${made.video.codec}${made.video.hdr ? "-hdr" : ""}` : `wish/voice-${made.audioCodec}`;
  // The real speed, for the couple's status page (spec §8.3): ids, sizes and times only.
  console.log(
    `[worker] media.wish job=${job.id} media=${mediaId}: ${kind}, ${made.durationSeconds.toFixed(1)} s made in ${made.convertMilliseconds} ms ` +
      `(${Math.round(performance.now() - startedAt)} ms with the download and upload)`,
  );

  const manifest = await markWishReady(mediaId, {
    derived: keys,
    derivedGeneration: item.derivedGeneration,
    durationSeconds: made.durationSeconds,
    width: made.video?.width ?? null,
    height: made.video?.height ?? null,
    thumbhash: made.poster?.placeholder.thumbhash ?? null,
    averageColor: made.poster?.placeholder.averageColor ?? null,
    videoCodec: made.video?.codec ?? null,
  });
  if (!manifest) {
    // Hidden, deleted, or unhidden into a new generation while it was made: its files come down.
    await withdrawIfHidden(job.queue, mediaId, Object.values(keys), {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: item.derivedGeneration,
    });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind };
}

/** media.wish's handler, with the worker's settings. */
export function wishHandler(options: WishOptions): MediaJobHandler {
  return (job) => processWish(job, options);
}
