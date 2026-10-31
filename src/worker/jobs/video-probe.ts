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
 * - it must hold exactly one video stream (cover art, a still image or a thumbnail track isn't
 *   one); audio is optional;
 * - that stream must have a codec and a size, no bigger than 8K.
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
  "stream=index,codec_type,codec_name,pix_fmt,width,height,color_range,color_space,color_transfer,color_primaries,duration",
  "stream_disposition=attached_pic,still_image,timed_thumbnails",
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

/** What the album keeps, and the poster needs, of a video. */
export type VideoFacts = {
  /** The video stream's index in the file, for ffmpeg's -map. */
  streamIndex: number;
  codec: string;
  /** The size it is shown at: the stored picture turned by its display matrix. */
  width: number;
  height: number;
  /** Null when the container doesn't say (a browser's WebM recording). */
  durationSeconds: number | null;
  /** Null for SDR. */
  hdr: HdrColours | null;
  audioCodecs: string[];
  /** Whether every phone's browser plays the original as it is: H.264, 8-bit 4:2:0, in MP4 or MOV, with AAC or no audio. */
  browserPlayable: boolean;
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
      pix_fmt: text,
      width: zod.number().int().optional(),
      height: zod.number().int().optional(),
      color_range: text,
      color_space: text,
      color_transfer: text,
      color_primaries: text,
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
 * Whether the display matrix turns the picture a quarter (either way), so it is shown with its
 * width and height swapped. ffprobe gives the matrix's turn in degrees counter-clockwise (an
 * iPhone's portrait video: -90); ffmpeg before 5 also gave a `rotate` tag, clockwise.
 */
function turnedQuarter(stream: ProbeStream): boolean {
  const rotation =
    stream.side_data_list?.find((sideData) => sideData.rotation !== undefined)?.rotation ?? Number(stream.tags?.rotate ?? 0);
  const quarterTurns = Math.round(rotation / 90);
  return Number.isFinite(quarterTurns) && Math.abs(quarterTurns) % 2 === 1;
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

  const videos = streams.filter(isMotionVideo);
  if (videos.length === 0) {
    const audioOnly = streams.some((stream) => stream.codec_type === "audio");
    return refused("unsupported-type", audioOnly ? "audio with no video" : "a file with no video stream");
  }
  if (videos.length > 1) return refused("unsupported-type", `a file with ${videos.length} video streams`);
  const [video] = videos;
  if (!video.codec_name || !video.width || !video.height || video.width < 1 || video.height < 1) {
    return refused("corrupt", "a video stream ffprobe couldn't size or name");
  }
  if (video.width * video.height > MAX_VIDEO_PIXELS) return refused("too-large", "a picture larger than 8K");

  const durationSeconds = seconds(format.duration) ?? seconds(video.duration);
  // Every QuickTime or MP4 video has a duration; a still image in one (an image item) has none.
  if (container === MOV_FAMILY && durationSeconds === null) return refused("unsupported-type", "a still image");

  const codec = CODEC_NAME.test(video.codec_name) ? video.codec_name : "unknown";
  const audioCodecs = streams.filter((stream) => stream.codec_type === "audio").map((stream) => stream.codec_name ?? "unknown");
  const turned = turnedQuarter(video);
  return {
    ok: true,
    facts: {
      streamIndex: video.index,
      codec,
      width: turned ? video.height : video.width,
      height: turned ? video.width : video.height,
      durationSeconds,
      hdr: hdrColours(video),
      audioCodecs,
      browserPlayable:
        container === MOV_FAMILY &&
        codec === "h264" &&
        PLAYABLE_PIXEL_FORMATS.has(video.pix_fmt ?? "") &&
        audioCodecs.every((audioCodec) => audioCodec === "aac"),
      capturedAt: captureTimeFromVideoTags({
        appleCreationDate: format.tags?.["com.apple.quicktime.creationdate"],
        creationTime: format.tags?.creation_time ?? video.tags?.creation_time,
      }),
    },
  };
}
