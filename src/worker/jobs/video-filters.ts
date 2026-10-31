import type { HdrColours, SdrColours, VideoFacts } from "./video-probe";

/*
 * ffmpeg's filters for a video's pictures, shared by its poster, its conversion and a video wish
 * (ffmpeg notes §2.0). Every colour they name comes from video-probe.ts's allowlists, never the
 * file's own text, so nothing from a guest's file reaches a filtergraph. None of them turns the
 * picture: ffmpeg's autorotate has already turned each frame upright by its display matrix before
 * the first of them (notes §4.1), so a turn of our own would turn a portrait iPhone video twice.
 */

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
 * scale's options (to append to a scale filter) that read an SDR picture's YUV by the matrix and
 * range the probe found, BT.709 when it found none: left to itself, scale reads an untagged video
 * as BT.601 and shifts its colours (ffmpeg notes §2.0, §4.9).
 */
export function sdrInput(sdr: SdrColours): string {
  return `:in_color_matrix=${SCALE_MATRIX[sdr.matrix]}:in_range=${sdr.range === "pc" ? "pc" : "tv"}`;
}

/**
 * HDR (PQ or HLG) to SDR BT.709 in 8-bit 4:2:0, in the order tonemap needs (ffmpeg notes §2.0,
 * §4.7): zscale makes it linear light from its own colours (1.0 = 100 nits, the reference white
 * tonemap assumes) as float RGB, converts BT.2020's primaries to BT.709's while still linear,
 * tonemap's hable curve brings its highlights into SDR's range, and zscale encodes it as BT.709,
 * limited range, tagging the frames so; format=yuv420p is the 10-to-8-bit step. Run it only on
 * what the probe calls PQ or HLG: SDR through it comes out darker, and untagged SDR fails (§4.7).
 */
export function hdrToSdr(hdr: HdrColours): string {
  const input = `tin=${hdr.transfer}:min=${ZSCALE_MATRIX[hdr.matrix]}:pin=${ZSCALE_PRIMARIES[hdr.primaries]}:rin=${ZSCALE_RANGE[hdr.range]}`;
  return [
    `zscale=${input}:t=linear:npl=100`,
    "format=gbrpf32le",
    "zscale=p=709",
    "tonemap=tonemap=hable:desat=0",
    "zscale=t=709:m=709:r=limited",
    "format=yuv420p",
  ].join(",");
}

/**
 * A scale filter that fits the picture within `longEdge` × `shortEdge` whichever way up it is (the
 * frame is already upright here), never enlarging it, with both sides even, as 4:2:0 and x264 need
 * (ffmpeg notes §2.0, §4.11): a portrait 1080 × 1920 phone video stays 1080 × 1920 in a 1920 × 1080
 * box, where the box as it is would shrink it to 608 × 1080. The single quotes keep min()'s commas
 * from splitting the filter chain.
 */
export function fitWithin(longEdge: number, shortEdge: number): string {
  return (
    `scale=w='if(gte(iw,ih),min(${longEdge},iw),min(${shortEdge},iw))'` +
    `:h='if(gte(iw,ih),min(${shortEdge},ih),min(${longEdge},ih))'` +
    ":force_original_aspect_ratio=decrease:force_divisible_by=2"
  );
}

/**
 * Tags an SDR picture's frames BT.709, limited range. ffmpeg 7.1's encoder takes a stream's colour
 * tags from its frames, not from -color_primaries or -color_trc (ffmpeg notes §4.9).
 */
const TAG_BT709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";

/**
 * Deletes the HDR side data that tonemap keeps (updating it) and libx264 would write into an SDR
 * stream: a PQ source's mastering display and light level, an iPhone's ambient viewing environment,
 * Dolby Vision's metadata, HDR10+ (ffmpeg notes §2.0, §4.6).
 */
const STRIP_HDR_SIDE_DATA = [
  "MASTERING_DISPLAY_METADATA",
  "CONTENT_LIGHT_LEVEL",
  "AMBIENT_VIEWING_ENVIRONMENT",
  "DOVI_RPU_BUFFER",
  "DOVI_METADATA",
  "DYNAMIC_HDR_PLUS",
]
  .map((sideDataType) => `sidedata=mode=delete:type=${sideDataType}`)
  .join(",");

/**
 * The video filters of a conversion to SDR H.264 within `longEdge` × `shortEdge` (ffmpeg notes
 * §2.3, §2.5): fitted first, so an HDR picture is tone-mapped at its new size rather than its full
 * 4K (less memory and time, §4.7), then turned into BT.709 8-bit 4:2:0 and tagged so, its HDR side
 * data deleted.
 * - HDR: hdrToSdr, whose last zscale tags the frames.
 * - SDR: scale converts its matrix and range to BT.709 limited (a full-range Android clip, or a
 *   BT.601 one), then setparams tags it; BT.601's primaries are close to BT.709's and stay (§4.9).
 */
export function convertedPictureFilters(facts: Pick<VideoFacts, "hdr" | "sdr">, longEdge: number, shortEdge: number): string {
  const fitted = fitWithin(longEdge, shortEdge);
  const colours = facts.hdr
    ? `${fitted},${hdrToSdr(facts.hdr)}`
    : `${fitted}${sdrInput(facts.sdr)}:out_color_matrix=bt709:out_range=tv,format=yuv420p,${TAG_BT709}`;
  return `${colours},${STRIP_HDR_SIDE_DATA}`;
}
