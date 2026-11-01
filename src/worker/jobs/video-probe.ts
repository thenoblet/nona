import * as zod from "zod";
import { captureTimeFromVideoTags } from "@/lib/media/capture-time";

/*
 * What ffprobe's description of an original says about it: the worker's layer 3 of the type
 * allowlist for videos, and the facts the album keeps. The upload API took the file on its
 * declared type (MP4, QuickTime, WebM, 3GPP or Matroska); here only what ffprobe found counts:
 * - the container must be one of those: ffmpeg's QuickTime/MP4 demuxer (MP4, MOV, 3GP) or its
 *   Matroska one (Matroska, WebM). ffprobe runs with only those two allowed, so anything else stops
 *   it before this;
 * - it must not be a photo in an ISO container (HEIC, HEIF, AVIF), which ffmpeg 7 reads as a
 *   one-frame video;
 * - it must hold at least one video stream ffmpeg knows (cover art, a still image or a thumbnail
 *   track isn't one); audio is optional. With several, the default one is the video, else the
 *   largest: an iPhone's Cinematic clip carries a smaller disparity track beside its picture;
 * - that stream must have a size, no bigger than 8K.
 * Its audio, if any, is one stream: AAC if it has one (an iPhone's Spatial Audio track beside its
 * stereo AAC isn't one every ffmpeg decodes), the default one among several, else the first.
 * Anything else fails for good: `unsupported-type`, `corrupt` or `too-large`. Pure, so its test
 * runs anywhere.
 */

/** ffmpeg's QuickTime and ISO media demuxer (MP4, MOV, 3GP), as ffprobe names it. */
export const MOV_FAMILY = "mov,mp4,m4a,3gp,3g2,mj2";
/** ffmpeg's Matroska demuxer (Matroska, WebM). */
export const MATROSKA_FAMILY = "matroska,webm";
/** The demuxers ffprobe and ffmpeg may use on an original (-format_whitelist): those two, by name. */
export const VIDEO_DEMUXERS = "mov,matroska";

/**
 * What ffprobe is asked to print (-show_entries): only what the album needs. No other tag, so no
 * location, is ever read. ffmpeg 4 and 7 both take it.
 */
export const PROBE_ENTRIES = [
  "format=format_name,duration",
  "format_tags=major_brand,creation_time,com.apple.quicktime.creationdate",
  "stream=index,codec_type,codec_name,level,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,avg_frame_rate,duration",
  "stream_disposition=default,attached_pic,still_image,timed_thumbnails",
  "stream_tags=rotate,creation_time",
  "stream_side_data_list",
].join(":");

/**
 * The most pixels a video's picture may have: H.264's and HEVC's top level (6.2) allows 8192 ×
 * 4352. Every phone's 8K is within it; past it a "video" is a threat to the worker's memory.
 */
const MAX_VIDEO_PIXELS = 8192 * 4352;

// The ISO media brands of HEIC, HEIF and AVIF stills and their image sequences.
const STILL_IMAGE_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "mif2", "msf1", "miaf", "avif", "avis"]);
// The pixel formats of 8-bit 4:2:0 video: limited range, and the full range many Android phones write.
const PLAYABLE_PIXEL_FORMATS = new Set(["yuv420p", "yuvj420p"]);
/**
 * What every phone decodes, as the original is (ffmpeg notes §4.19): at most 1080p (its long edge),
 * 60 frames a second and H.264 level 4.2 (ffprobe gives the level times ten). A 4K, slow-motion or
 * higher-level H.264 video gets a 1080p conversion instead. The frame rate is an average, which a
 * phone's variable-frame-rate 60 fps clip puts a little over 60 (60.02): half a frame's slack
 * keeps it playable, while slow motion (120 or 240) stays far past it.
 */
const PLAYABLE_LONG_EDGE = 1920;
const PLAYABLE_FRAMES_PER_SECOND = 60.5;
const PLAYABLE_H264_LEVEL = 42;
// 3GPP's brands: a 3GP file isn't an MP4 or MOV, whatever its codecs.
const THIRD_GENERATION_BRAND = /^3g[p2]/;
// A codec's name as ffmpeg gives it: anything else is never stored or logged.
const CODEC_NAME = /^[a-z0-9_]{1,32}$/;

/** The colours an HDR video's poster is tone-mapped from, only ever values named here. */
export type HdrColours = {
  /** PQ (HDR10, Dolby Vision 8.1) or HLG (an iPhone's, often under Dolby Vision 8.4). */
  transfer: "smpte2084" | "arib-std-b67";
  matrix: "bt2020nc" | "bt2020c" | "bt709";
  primaries: "bt2020" | "bt709";
  range: "tv" | "pc";
};

/**
 * The YUV matrix and range an SDR video's picture is turned into RGB with. An untagged phone video
 * is BT.709 in practice; left to itself, ffmpeg would read an untagged one as BT.601.
 */
export type SdrColours = {
  matrix: "bt709" | "smpte170m" | "bt470bg" | "bt2020nc";
  range: "tv" | "pc";
};

/** What the album keeps, and the poster needs, of a video. */
export type VideoFacts = {
  /** The video stream's index in the file, for ffmpeg's -map: the video, never a second track. */
  streamIndex: number;
  /** The audio stream a conversion keeps, for ffmpeg's -map; null when it has none ffmpeg can name. */
  audioStreamIndex: number | null;
  /** That audio stream's codec, as ffmpeg names it; null with no audio stream. */
  audioCodec: string | null;
  codec: string;
  /** The size it is shown at: the stored picture turned by its display matrix. */
  width: number;
  height: number;
  /**
   * Its display matrix's turn, in degrees counter-clockwise, as ffprobe gives it (an iPhone's
   * portrait: −90; ffmpeg notes §4.2); 0 when it has none. A clean copy must keep it.
   */
  rotation: number;
  /** Null when the container doesn't say (a browser's WebM recording). */
  durationSeconds: number | null;
  /** The video stream's own duration, which may be shorter than the container's: where a poster can be. */
  videoStreamSeconds: number | null;
  /** The video's average frame rate (60 for a phone's 60 fps, 240 for slow motion); null when ffprobe doesn't say. */
  framesPerSecond: number | null;
  /** Null for SDR. */
  hdr: HdrColours | null;
  audioCodecs: string[];
  /**
   * Whether every phone's browser plays the original as it is: H.264, 8-bit 4:2:0, at most 1080p,
   * 60 fps and level 4.2, in MP4 or MOV (not 3GP), with AAC or no audio.
   */
  browserPlayable: boolean;
  /** The colours an SDR picture is converted from, only ever values named here. */
  sdr: SdrColours;
  /** From the container's tags; null when they hold none. */
  capturedAt: Date | null;
};

export type VideoCheck =
  | { ok: true; facts: VideoFacts }
  | {
      ok: false;
      reason: "unsupported-type" | "corrupt" | "too-large";
      /** What the file was, in words for the log, never the file's own text. */
      found: string;
    };

const text = zod.string().optional();
const tags = zod.record(zod.string(), zod.string()).optional();

const probeSchema = zod.object({
  format: zod.object({ format_name: zod.string(), duration: text, tags }),
  streams: zod.array(
    zod.object({
      index: zod.number().int().min(0),
      codec_type: text,
      codec_name: text,
      level: zod.number().int().optional(),
      pix_fmt: text,
      width: zod.number().int().optional(),
      height: zod.number().int().optional(),
      color_range: text,
      color_space: text,
      color_transfer: text,
      color_primaries: text,
      avg_frame_rate: text,
      duration: text,
      disposition: zod.record(zod.string(), zod.number()).optional(),
      tags,
      side_data_list: zod.array(zod.object({ rotation: zod.number().optional() })).optional(),
    }),
  ),
});

type ProbeStream = zod.infer<typeof probeSchema>["streams"][number];

/** A duration ffprobe gave ("12.500000"), or null for none, "N/A" or nonsense. */
function seconds(value: string | undefined): number | null {
  const parsed = Number(value);
  return value !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The display matrix's turn, in degrees counter-clockwise, as ffprobe gives it (an iPhone's portrait
 * video: -90); 0 when there is none. ffmpeg before 5 gave a `rotate` tag instead, clockwise.
 */
function rotationOf(stream: ProbeStream): number {
  const counterClockwise = stream.side_data_list?.find((sideData) => sideData.rotation !== undefined)?.rotation;
  const rotation = counterClockwise ?? -Number(stream.tags?.rotate ?? 0);
  // A tag of "0" gives -0, which is no turn.
  return Number.isFinite(rotation) && rotation !== 0 ? rotation : 0;
}

/** Whether the display matrix turns the picture a quarter (either way), so it is shown with its width and height swapped. */
function turnedQuarter(stream: ProbeStream): boolean {
  const quarterTurns = Math.round(rotationOf(stream) / 90);
  return Math.abs(quarterTurns) % 2 === 1;
}

/** One of the values given, or the first when the file says something else. */
function oneOf<TValue extends string>(value: string | undefined, allowed: readonly [TValue, ...TValue[]]): TValue {
  return (allowed as readonly string[]).includes(value ?? "") ? (value as TValue) : allowed[0];
}

/** The HDR colours of a PQ or HLG stream, each from the few ffmpeg's filters are given; null for SDR. */
function hdrColours(stream: ProbeStream): HdrColours | null {
  if (stream.color_transfer !== "smpte2084" && stream.color_transfer !== "arib-std-b67") return null;
  return {
    transfer: stream.color_transfer,
    matrix: oneOf(stream.color_space, ["bt2020nc", "bt2020c", "bt709"]),
    primaries: oneOf(stream.color_primaries, ["bt2020", "bt709"]),
    range: oneOf(stream.color_range, ["tv", "pc"]),
  };
}

/** A video stream that is a video: not cover art, a still image or a track of thumbnails. */
function isMotionVideo(stream: ProbeStream): boolean {
  const disposition = stream.disposition ?? {};
  return (
    stream.codec_type === "video" && !disposition.attached_pic && !disposition.still_image && !disposition.timed_thumbnails
  );
}

/** The picture's area, 0 when ffprobe couldn't size it. */
function areaOf(stream: ProbeStream): number {
  return Math.max(0, stream.width ?? 0) * Math.max(0, stream.height ?? 0);
}

/**
 * The video among several: the default stream (a phone marks its picture so), else the largest,
 * else the first. An iPhone's Cinematic clip, for one, carries a smaller disparity track beside it.
 */
function theVideo(videos: ProbeStream[]): ProbeStream {
  const defaults = videos.filter((stream) => stream.disposition?.default);
  const candidates = defaults.length > 0 ? defaults : videos;
  return candidates.reduce((largest, stream) => (areaOf(stream) > areaOf(largest) ? stream : largest));
}

/** Frames a second from ffprobe's "30000/1001", or null when it doesn't say ("0/0"). */
function framesPerSecond(value: string | undefined): number | null {
  const [numerator, denominator] = (value ?? "").split("/").map(Number);
  const rate = numerator / denominator;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * The audio stream to keep, among those ffprobe names a codec for: AAC first (every phone's, and a
 * newer iPhone writes a Spatial Audio track beside its stereo AAC), then the default stream, then
 * the first; null when there is none (ffmpeg notes §6).
 */
function theAudio(streams: ProbeStream[]): ProbeStream | null {
  const audios = streams.filter((stream) => stream.codec_type === "audio" && CODEC_NAME.test(stream.codec_name ?? ""));
  const aac = audios.filter((stream) => stream.codec_name === "aac");
  const candidates = aac.length > 0 ? aac : audios;
  return candidates.find((stream) => stream.disposition?.default) ?? candidates[0] ?? null;
}

function refused(reason: "unsupported-type" | "corrupt" | "too-large", found: string): VideoCheck {
  return { ok: false, reason, found };
}

/** What ffprobe's JSON (run with PROBE_ENTRIES) says of an original: a video the album takes, with its facts, or why not. */
export function videoFactsFrom(probeJson: unknown): VideoCheck {
  const parsed = probeSchema.safeParse(probeJson);
  if (!parsed.success) return refused("corrupt", "a file ffprobe couldn't describe");
  const { format, streams } = parsed.data;
  const container = format.format_name;
  if (container !== MOV_FAMILY && container !== MATROSKA_FAMILY) {
    return refused("unsupported-type", "a file in a container the album doesn't take");
  }
  if (container === MOV_FAMILY && STILL_IMAGE_BRANDS.has((format.tags?.major_brand ?? "").trim())) {
    return refused("unsupported-type", "a photo (HEIC, HEIF or AVIF)");
  }
  if (streams.length === 0) return refused("corrupt", "a container with nothing in it");

  const motionVideos = streams.filter(isMotionVideo);
  if (motionVideos.length === 0) {
    const audioOnly = streams.some((stream) => stream.codec_type === "audio");
    return refused("unsupported-type", audioOnly ? "audio with no video" : "a file with no video stream");
  }
  // Only a stream ffmpeg can name is one it can decode.
  const videos = motionVideos.filter((stream) => stream.codec_name);
  if (videos.length === 0) return refused("corrupt", "a video stream of a codec ffprobe doesn't know");
  const video = theVideo(videos);
  if (!video.width || !video.height || video.width < 1 || video.height < 1) {
    return refused("corrupt", "a video stream ffprobe couldn't size");
  }
  if (areaOf(video) > MAX_VIDEO_PIXELS) return refused("too-large", "a picture larger than 8K");

  const videoStreamSeconds = seconds(video.duration);
  const durationSeconds = seconds(format.duration) ?? videoStreamSeconds;
  // Every QuickTime or MP4 video has a duration; a still image in one (an image item) has none.
  if (container === MOV_FAMILY && durationSeconds === null) return refused("unsupported-type", "a still image");

  const codec = CODEC_NAME.test(video.codec_name ?? "") ? (video.codec_name as string) : "unknown";
  const audioCodecs = streams.filter((stream) => stream.codec_type === "audio").map((stream) => stream.codec_name ?? "unknown");
  const turned = turnedQuarter(video);
  const audio = theAudio(streams);
  const rate = framesPerSecond(video.avg_frame_rate);
  const browserPlayable =
    container === MOV_FAMILY &&
    !THIRD_GENERATION_BRAND.test(format.tags?.major_brand ?? "") &&
    codec === "h264" &&
    PLAYABLE_PIXEL_FORMATS.has(video.pix_fmt ?? "") &&
    Math.max(video.width, video.height) <= PLAYABLE_LONG_EDGE &&
    rate !== null &&
    rate <= PLAYABLE_FRAMES_PER_SECOND &&
    video.level !== undefined &&
    video.level > 0 &&
    video.level <= PLAYABLE_H264_LEVEL &&
    audioCodecs.every((audioCodec) => audioCodec === "aac");
  return {
    ok: true,
    facts: {
      streamIndex: video.index,
      audioStreamIndex: audio?.index ?? null,
      // theAudio takes only a stream whose codec name passes CODEC_NAME.
      audioCodec: audio?.codec_name ?? null,
      codec,
      width: turned ? video.height : video.width,
      height: turned ? video.width : video.height,
      rotation: rotationOf(video),
      durationSeconds,
      videoStreamSeconds,
      framesPerSecond: rate,
      hdr: hdrColours(video),
      audioCodecs,
      browserPlayable,
      sdr: {
        matrix: oneOf(video.color_space, ["bt709", "smpte170m", "bt470bg", "bt2020nc"]),
        range: oneOf(video.color_range, ["tv", "pc"]),
      },
      capturedAt: captureTimeFromVideoTags({
        appleCreationDate: format.tags?.["com.apple.quicktime.creationdate"],
        creationTime: format.tags?.creation_time ?? video.tags?.creation_time,
      }),
    },
  };
}
