import { describe, expect, it } from "vitest";
import { MOV_FAMILY, videoFactsFrom, type VideoFacts } from "./video-probe";

/*
 * What ffprobe's description of a file says about it: the worker's layer 3 of the type allowlist
 * for videos, and which phones can play it. Pure, so these run anywhere; poster.test.ts runs
 * ffprobe itself on real files.
 */

type ProbeStream = Record<string, unknown>;

/** A stream as ffprobe -show_entries describes it, with any of its fields changed. */
function videoStream(changes: ProbeStream = {}): ProbeStream {
  return {
    index: 0,
    codec_name: "h264",
    codec_type: "video",
    width: 1920,
    height: 1080,
    level: 40,
    pix_fmt: "yuv420p",
    avg_frame_rate: "30/1",
    duration: "12.500000",
    disposition: { default: 1, attached_pic: 0, timed_thumbnails: 0, still_image: 0 },
    tags: {},
    ...changes,
  };
}

function audioStream(codec = "aac", index = 1): ProbeStream {
  return { index, codec_name: codec, codec_type: "audio", disposition: { attached_pic: 0 } };
}

/** ffprobe's JSON for a file: an MP4 holding these streams unless the format says otherwise. */
function probe(streams: ProbeStream[], format: Record<string, unknown> = {}) {
  return {
    programs: [],
    streams,
    format: { format_name: MOV_FAMILY, duration: "12.500000", tags: { major_brand: "isom" }, ...format },
  };
}

function facts(json: unknown): VideoFacts {
  const check = videoFactsFrom(json);
  if (!check.ok) throw new Error(`Expected a video, got ${check.reason}: ${check.found}`);
  return check.facts;
}

function refusal(json: unknown) {
  const check = videoFactsFrom(json);
  return check.ok ? "accepted" : check.reason;
}

describe("videoFactsFrom: what the album needs to know of a video", () => {
  it("reads the duration, codec, size, audio and capture time of an Android phone's H.264 MP4", () => {
    const read = facts(
      probe([videoStream(), audioStream()], {
        tags: { major_brand: "isom", creation_time: "2026-12-05T10:30:00.000000Z" },
      }),
    );
    expect(read).toEqual({
      streamIndex: 0,
      audioStreamIndex: 1,
      codec: "h264",
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
      videoStreamSeconds: 12.5,
      hdr: null,
      audioCodecs: ["aac"],
      browserPlayable: true,
      sdr: { matrix: "bt709", range: "tv" },
      capturedAt: new Date("2026-12-05T10:30:00.000Z"),
    });
  });

  it("names the SDR colours only from the ones it knows, BT.709 when the file says none", () => {
    expect(facts(probe([videoStream({ color_space: "smpte170m", color_range: "pc" })])).sdr).toEqual({
      matrix: "smpte170m",
      range: "pc",
    });
    expect(facts(probe([videoStream({ color_space: "bt470bg" })])).sdr).toEqual({ matrix: "bt470bg", range: "tv" });
    expect(facts(probe([videoStream({ color_space: "gbr,scale=1", color_range: "unknown" })])).sdr).toEqual({
      matrix: "bt709",
      range: "tv",
    });
  });

  it("turns the size by the display matrix's quarter turns, either way and from either ffmpeg's way of saying it", () => {
    const rotations: [ProbeStream, number, number][] = [
      [{ side_data_list: [{ side_data_type: "Display Matrix", rotation: -90 }] }, 1080, 1920],
      [{ side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }] }, 1080, 1920],
      [{ side_data_list: [{ side_data_type: "Display Matrix", rotation: 180 }] }, 1920, 1080],
      [{ side_data_list: [{ side_data_type: "Display Matrix", rotation: -270 }] }, 1080, 1920],
      // ffmpeg before 5 also gave it as a tag, in degrees clockwise.
      [{ tags: { rotate: "270" } }, 1080, 1920],
      [{ side_data_list: [{ side_data_type: "Mastering display metadata" }] }, 1920, 1080],
    ];
    for (const [changes, width, height] of rotations) {
      expect(facts(probe([videoStream(changes)])), JSON.stringify(changes)).toMatchObject({ width, height });
    }
  });

  it("knows an iPhone's HDR: HLG (often Dolby Vision 8.4 over it) or PQ, with its colours", () => {
    const iphone = videoStream({
      codec_name: "hevc",
      pix_fmt: "yuv420p10le",
      color_range: "tv",
      color_space: "bt2020nc",
      color_transfer: "arib-std-b67",
      color_primaries: "bt2020",
      side_data_list: [{ side_data_type: "DOVI configuration record" }, { side_data_type: "Display Matrix", rotation: -90 }],
    });
    expect(facts(probe([iphone, audioStream()], { tags: { major_brand: "qt  " } }))).toMatchObject({
      codec: "hevc",
      width: 1080,
      height: 1920,
      hdr: { transfer: "arib-std-b67", matrix: "bt2020nc", primaries: "bt2020", range: "tv" },
      browserPlayable: false,
    });
    const pq = videoStream({ codec_name: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084" });
    expect(facts(probe([pq])).hdr).toEqual({ transfer: "smpte2084", matrix: "bt2020nc", primaries: "bt2020", range: "tv" });
  });

  it("names the HDR colours only from the ones it knows, so nothing from the file reaches ffmpeg's filters", () => {
    const odd = videoStream({
      codec_name: "hevc",
      color_transfer: "arib-std-b67",
      color_space: "bt2020c,zscale=x",
      color_primaries: "unknown",
      color_range: "pc",
    });
    expect(facts(probe([odd])).hdr).toEqual({ transfer: "arib-std-b67", matrix: "bt2020nc", primaries: "bt2020", range: "pc" });
    expect(facts(probe([videoStream({ color_transfer: "bt709" })])).hdr).toBeNull();
  });

  it("takes Apple's creationdate, with its offset, before creation_time, and the video stream's creation_time last", () => {
    const apple = probe([videoStream()], {
      tags: {
        major_brand: "qt  ",
        "com.apple.quicktime.creationdate": "2026-12-06T01:00:00+0200",
        creation_time: "2026-12-05T23:00:05.000000Z",
      },
    });
    expect(facts(apple).capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    const streamOnly = probe([videoStream({ tags: { creation_time: "2026-12-05T11:00:00.000000Z" } })]);
    expect(facts(streamOnly).capturedAt?.toISOString()).toBe("2026-12-05T11:00:00.000Z");
    expect(facts(probe([videoStream()])).capturedAt).toBeNull();
  });

  it("takes the video stream's duration when the container has none, and has none when neither does (a phone's WebM)", () => {
    expect(facts(probe([videoStream({ duration: "4.000000" })], { duration: undefined })).durationSeconds).toBe(4);
    // The video stream's own duration is kept apart: audio can run on past the last frame.
    expect(facts(probe([videoStream({ duration: "0.033333" })], { duration: "2.000000" }))).toMatchObject({
      durationSeconds: 2,
      videoStreamSeconds: 0.033333,
    });
    const webm = probe([videoStream({ codec_name: "vp9", duration: undefined })], {
      format_name: "matroska,webm",
      duration: undefined,
      tags: {},
    });
    expect(facts(webm).durationSeconds).toBeNull();
    expect(facts(probe([videoStream()], { duration: "N/A" })).durationSeconds).toBe(12.5);
  });

  it("keeps one audio stream for a conversion: AAC first, then the default, then the first; none when ffprobe names none (ffmpeg notes §6)", () => {
    const withDefault = (codec: string, index: number, isDefault: boolean) => ({
      ...audioStream(codec, index),
      disposition: { default: isDefault ? 1 : 0, attached_pic: 0 },
    });
    // A newer iPhone's Spatial Audio track (no codec ffmpeg 7.1 names, or one it can't decode) beside its stereo AAC.
    expect(facts(probe([videoStream(), audioStream("apac", 1), audioStream("aac", 2)])).audioStreamIndex).toBe(2);
    expect(facts(probe([videoStream(), { index: 1, codec_type: "audio" }, audioStream("aac", 2)])).audioStreamIndex).toBe(2);
    // Two AAC streams: the default one.
    expect(facts(probe([videoStream(), withDefault("aac", 1, false), withDefault("aac", 2, true)])).audioStreamIndex).toBe(2);
    // No AAC: the default, else the first.
    expect(facts(probe([videoStream(), withDefault("opus", 1, false), withDefault("mp3", 2, true)])).audioStreamIndex).toBe(2);
    expect(facts(probe([videoStream(), audioStream("opus", 1), audioStream("mp3", 2)])).audioStreamIndex).toBe(1);
    // None, or none ffprobe can name.
    expect(facts(probe([videoStream()])).audioStreamIndex).toBeNull();
    expect(facts(probe([videoStream(), { index: 1, codec_type: "audio" }])).audioStreamIndex).toBeNull();
  });

  it("uses the video stream's own index, for ffmpeg to take that stream and no other", () => {
    const read = facts(probe([audioStream("aac", 0), { index: 1, codec_type: "data", codec_name: "bin_data" }, videoStream({ index: 2 })]));
    expect(read).toMatchObject({ streamIndex: 2, audioCodecs: ["aac"] });
  });
});

describe("videoFactsFrom: which phones can play the original as it is", () => {
  it("is only H.264, 8-bit 4:2:0, up to 1080p60 and level 4.2, in MP4 or MOV, with AAC or no audio", () => {
    expect(facts(probe([videoStream(), audioStream()])).browserPlayable).toBe(true);
    expect(facts(probe([videoStream()])).browserPlayable).toBe(true);
    expect(facts(probe([videoStream()], { tags: { major_brand: "qt  " } })).browserPlayable).toBe(true);
    // Many Android phones write full-range 8-bit 4:2:0, which every browser plays.
    expect(facts(probe([videoStream({ pix_fmt: "yuvj420p" })])).browserPlayable).toBe(true);
    // Portrait 1080p, 1080p60 at level 4.2, and an NTSC frame rate.
    expect(facts(probe([videoStream({ width: 1080, height: 1920 })])).browserPlayable).toBe(true);
    expect(facts(probe([videoStream({ avg_frame_rate: "60/1", level: 42 })])).browserPlayable).toBe(true);
    expect(facts(probe([videoStream({ avg_frame_rate: "30000/1001" })])).browserPlayable).toBe(true);
    // A phone's variable-frame-rate 60 fps clip averages a little over 60 (Ruling AP).
    expect(facts(probe([videoStream({ avg_frame_rate: "3001/50", level: 42 })])).browserPlayable).toBe(true);
    expect(facts(probe([videoStream({ avg_frame_rate: "121/2", level: 42 })])).browserPlayable).toBe(true);
  });

  it("isn't HEVC, 10-bit or 4:2:2 H.264, another audio codec, or H.264 in Matroska", () => {
    const unplayable: [string, unknown][] = [
      ["hevc", probe([videoStream({ codec_name: "hevc" })])],
      ["10-bit", probe([videoStream({ pix_fmt: "yuv420p10le" })])],
      ["4:2:2", probe([videoStream({ pix_fmt: "yuv422p" })])],
      ["opus", probe([videoStream(), audioStream("opus")])],
      ["a second audio stream in MP3", probe([videoStream(), audioStream("aac"), audioStream("mp3", 2)])],
      ["matroska", probe([videoStream()], { format_name: "matroska,webm" })],
      ["no pixel format", probe([videoStream({ pix_fmt: undefined })])],
      ["3GP", probe([videoStream()], { tags: { major_brand: "3gp4" } })],
      ["3G2", probe([videoStream()], { tags: { major_brand: "3g2a" } })],
      ["4K", probe([videoStream({ width: 3840, height: 2160, level: 51 })])],
      ["4K at level 4.2", probe([videoStream({ width: 3840, height: 2160 })])],
      ["slow motion", probe([videoStream({ avg_frame_rate: "240/1", level: 42 })])],
      ["past 60 fps by more than half a frame", probe([videoStream({ avg_frame_rate: "6051/100", level: 42 })])],
      ["level 5.1", probe([videoStream({ level: 51 })])],
      ["no level", probe([videoStream({ level: undefined })])],
      ["no frame rate", probe([videoStream({ avg_frame_rate: "0/0" })])],
    ];
    for (const [what, json] of unplayable) {
      expect(facts(json).browserPlayable, what).toBe(false);
    }
  });
});

describe("videoFactsFrom: what isn't a video the album takes (layer 3, Review Focus 5)", () => {
  it("refuses a container other than MP4, MOV, 3GP, WebM or Matroska", () => {
    for (const format_name of ["image2", "jpeg_pipe", "mp3", "avi", "mpegts", "hls"]) {
      expect(refusal(probe([videoStream()], { format_name })), format_name).toBe("unsupported-type");
    }
  });

  it("refuses a photo in an ISO container (HEIC, HEIF or AVIF), though ffmpeg reads it as a video", () => {
    for (const major_brand of ["heic", "mif1", "avif", "heix", "msf1"]) {
      expect(refusal(probe([videoStream({ codec_name: "hevc", duration: undefined })], { duration: undefined, tags: { major_brand } })), major_brand).toBe(
        "unsupported-type",
      );
    }
    // A still with no brand that says so: no duration anywhere, which no QuickTime or MP4 video lacks.
    expect(refusal(probe([videoStream({ duration: undefined })], { duration: undefined }))).toBe("unsupported-type");
  });

  it("refuses audio alone, cover art over audio, and a file with no video stream at all", () => {
    expect(refusal(probe([audioStream("aac", 0)]))).toBe("unsupported-type");
    const coverArt = videoStream({ codec_name: "mjpeg", disposition: { attached_pic: 1 } });
    expect(refusal(probe([audioStream("aac", 0), { ...coverArt, index: 1 }]))).toBe("unsupported-type");
    expect(refusal(probe([{ index: 0, codec_type: "data", codec_name: "bin_data" }]))).toBe("unsupported-type");
    expect(refusal(probe([]))).toBe("corrupt");
  });

  it("takes the default video stream among several, else the largest, else the first: a Cinematic clip's disparity track is no second video", () => {
    const notDefault = { default: 0, attached_pic: 0, timed_thumbnails: 0, still_image: 0 };
    const disparity = (index: number, isDefault: number) =>
      videoStream({ index, codec_name: "hevc", width: 480, height: 270, disposition: { ...notDefault, default: isDefault } });
    // The picture marked default, though a larger one comes first.
    const marked = probe([videoStream({ index: 0, width: 3840, height: 2160, disposition: notDefault }), videoStream({ index: 1 })]);
    expect(facts(marked)).toMatchObject({ streamIndex: 1, width: 1920 });
    // None marked: the largest, wherever it is.
    const unmarked = probe([disparity(0, 0), videoStream({ index: 1, disposition: notDefault }), audioStream("aac", 2)]);
    expect(facts(unmarked)).toMatchObject({ streamIndex: 1, width: 1920, codec: "h264" });
    // Both marked: the larger of them.
    expect(facts(probe([disparity(0, 1), videoStream({ index: 1 })])).streamIndex).toBe(1);
    // Two alike: the first.
    expect(facts(probe([videoStream({ index: 0 }), videoStream({ index: 1 })])).streamIndex).toBe(0);
    // A video beside a data track and its own thumbnail track.
    const withThumbnail = probe([
      { index: 0, codec_type: "data", codec_name: "bin_data" },
      videoStream({ index: 1, codec_name: "mjpeg", width: 4000, height: 3000, disposition: { timed_thumbnails: 1 } }),
      videoStream({ index: 2 }),
    ]);
    expect(facts(withThumbnail).streamIndex).toBe(2);
  });

  it("refuses a still image or thumbnail track standing in for a video, and passes over a video stream of no known codec", () => {
    expect(refusal(probe([videoStream({ disposition: { still_image: 1 } })]))).toBe("unsupported-type");
    expect(refusal(probe([videoStream({ disposition: { timed_thumbnails: 1 } })]))).toBe("unsupported-type");
    const unknownBeside = probe([videoStream({ index: 0, codec_name: undefined, width: 3840, height: 2160 }), videoStream({ index: 1 })]);
    expect(facts(unknownBeside).streamIndex).toBe(1);
  });

  it("calls a video stream ffprobe can't size or name corrupt", () => {
    for (const changes of [{ width: 0 }, { height: undefined }, { codec_name: undefined }, { width: -4 }]) {
      expect(refusal(probe([videoStream(changes)])), JSON.stringify(changes)).toBe("corrupt");
    }
  });

  it("calls a picture larger than H.264 and HEVC's top level allows (8K) too large", () => {
    expect(refusal(probe([videoStream({ width: 7680, height: 4320 })]))).toBe("accepted");
    expect(refusal(probe([videoStream({ width: 8192, height: 4352 })]))).toBe("accepted");
    expect(refusal(probe([videoStream({ width: 16384, height: 16384 })]))).toBe("too-large");
  });

  it("calls a description it can't read corrupt", () => {
    for (const json of [null, "text", {}, { streams: "none", format: {} }, { streams: [], format: { duration: "1" } }]) {
      expect(refusal(json), JSON.stringify(json)).toBe("corrupt");
    }
  });

  it("names what it found in words, never the file's own text", () => {
    const check = videoFactsFrom(probe([videoStream()], { tags: { major_brand: "heic", title: "Ama's secret" } }));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.found).not.toContain("Ama");
  });
});
