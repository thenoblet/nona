import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import {
  ALBUM_PICKER_ACCEPT,
  checkUpload,
  LARGE_FILE_BYTES,
  LARGE_PART_SIZE_BYTES,
  MAX_PART_COUNT,
  normalizeContentType,
  PART_SIZE_BYTES,
  partCount,
  partSizeFor,
  partSizeOf,
  SIZE_LIMITS,
  type UploadCheck,
} from "./limits";

const MEBIBYTE = 1024 * 1024;

function check(overrides: Partial<Parameters<typeof checkUpload>[0]> = {}): UploadCheck {
  return checkUpload({
    purpose: "album",
    filename: "IMG_0001.JPG",
    contentType: "image/jpeg",
    size: 3 * MEBIBYTE,
    ...overrides,
  });
}

function refusal(result: UploadCheck): { error: string; message: string } {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return { error: result.error, message: result.message };
}

describe("the limits", () => {
  it("are the plan's: photos 50 MB, videos 2 GB, voice wishes 20 MB, video wishes 400 MB (Ruling CD)", () => {
    expect(SIZE_LIMITS).toEqual({
      photo: 50 * MEBIBYTE,
      video: 2 * 1024 * MEBIBYTE,
      voiceWish: 20 * MEBIBYTE,
      videoWish: 400 * MEBIBYTE,
    });
  });

  it("send a file under 256 MiB in 8 MiB parts, and one of 256 MiB or more in 16 MiB parts", () => {
    expect(PART_SIZE_BYTES).toBe(8_388_608);
    expect(LARGE_PART_SIZE_BYTES).toBe(16_777_216);
    expect(LARGE_FILE_BYTES).toBe(256 * MEBIBYTE);
    expect(partSizeFor(1)).toBe(PART_SIZE_BYTES);
    expect(partSizeFor(SIZE_LIMITS.photo)).toBe(PART_SIZE_BYTES);
    expect(partSizeFor(LARGE_FILE_BYTES - 1)).toBe(PART_SIZE_BYTES);
    expect(partSizeFor(LARGE_FILE_BYTES)).toBe(LARGE_PART_SIZE_BYTES);
    expect(partSizeFor(300_000_000)).toBe(LARGE_PART_SIZE_BYTES);
    expect(partSizeFor(SIZE_LIMITS.video)).toBe(LARGE_PART_SIZE_BYTES);
  });

  it("stay within R2's multipart limits for every size the album takes: parts of 5 MiB or more, at most 10,000 of them", () => {
    for (const size of [1, 5 * MEBIBYTE, SIZE_LIMITS.photo, LARGE_FILE_BYTES - 1, LARGE_FILE_BYTES, 300_000_000, SIZE_LIMITS.video]) {
      const partSize = partSizeFor(size);
      expect(partSize, String(size)).toBeGreaterThanOrEqual(5 * MEBIBYTE);
      expect(partCount(size, partSize), String(size)).toBeLessThanOrEqual(10_000);
    }
  });

  it("count a file's parts as its size over its part size, rounded up", () => {
    expect(partCount(1, PART_SIZE_BYTES)).toBe(1);
    expect(partCount(PART_SIZE_BYTES, PART_SIZE_BYTES)).toBe(1);
    expect(partCount(PART_SIZE_BYTES + 1, PART_SIZE_BYTES)).toBe(2);
    expect(partCount(LARGE_FILE_BYTES - 1, PART_SIZE_BYTES)).toBe(32);
    expect(partCount(300_000_000, LARGE_PART_SIZE_BYTES)).toBe(18);
    expect(partCount(SIZE_LIMITS.video, LARGE_PART_SIZE_BYTES)).toBe(128);
    // Uploads started in 8 MiB parts before big files took 16 MiB ones keep theirs: up to 256.
    expect(partCount(SIZE_LIMITS.video, PART_SIZE_BYTES)).toBe(256);
    expect(MAX_PART_COUNT).toBe(256);
  });

  it("give every part the upload's part size but the last, which takes the remainder", () => {
    expect(partSizeOf(PART_SIZE_BYTES + 1000, 1, PART_SIZE_BYTES)).toBe(PART_SIZE_BYTES);
    expect(partSizeOf(PART_SIZE_BYTES + 1000, 2, PART_SIZE_BYTES)).toBe(1000);
    expect(partSizeOf(2 * PART_SIZE_BYTES, 2, PART_SIZE_BYTES)).toBe(PART_SIZE_BYTES);
    expect(partSizeOf(4000, 1, PART_SIZE_BYTES)).toBe(4000);
    expect(partSizeOf(SIZE_LIMITS.video, 256, PART_SIZE_BYTES)).toBe(PART_SIZE_BYTES);
    expect(partSizeOf(300_000_000, 1, LARGE_PART_SIZE_BYTES)).toBe(LARGE_PART_SIZE_BYTES);
    expect(partSizeOf(300_000_000, 18, LARGE_PART_SIZE_BYTES)).toBe(300_000_000 - 17 * LARGE_PART_SIZE_BYTES);
  });
});

describe("checkUpload", () => {
  it("accepts an album photo, keeping its own extension in lower case", () => {
    expect(check()).toEqual({
      ok: true,
      kind: "photo",
      contentType: "image/jpeg",
      extension: "jpg",
      partSize: PART_SIZE_BYTES,
      partCount: 1,
    });
    expect(check({ filename: "scan.JPEG" })).toMatchObject({ ok: true, extension: "jpeg" });
  });

  it("accepts every photo and video type on the album's list, and video for a wish", () => {
    const photos = ["image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "image/gif", "image/avif"];
    const videos = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-matroska"];
    for (const contentType of photos) {
      expect(check({ contentType, filename: "photo" }), contentType).toMatchObject({ ok: true, kind: "photo" });
    }
    for (const contentType of videos) {
      expect(check({ contentType, filename: "clip" }), contentType).toMatchObject({ ok: true, kind: "video" });
      expect(check({ purpose: "wish", contentType, filename: "clip" }), contentType).toMatchObject({
        ok: true,
        kind: "video",
      });
    }
  });

  it("accepts audio for a voice wish", () => {
    const voices = [
      "audio/mp4",
      "audio/m4a",
      "audio/x-m4a",
      "audio/aac",
      "audio/mpeg",
      "audio/webm",
      "audio/ogg",
      "audio/wav",
      "audio/x-wav",
      "audio/amr",
      "audio/3gpp",
    ];
    for (const contentType of voices) {
      expect(check({ purpose: "wish", contentType, filename: "wish" }), contentType).toMatchObject({
        ok: true,
        kind: "audio",
      });
    }
    // A recorder's type carries its codec, which is dropped.
    expect(check({ purpose: "wish", contentType: "audio/webm;codecs=opus", filename: "" })).toEqual({
      ok: true,
      kind: "audio",
      contentType: "audio/webm",
      extension: "webm",
      partSize: PART_SIZE_BYTES,
      partCount: 1,
    });
  });

  it("refuses audio for the album, and a photo for a wish", () => {
    expect(refusal(check({ contentType: "audio/mp4", filename: "voice.m4a" }))).toEqual({
      error: "unsupported-type",
      message: "Only photos and videos can be shared here.",
    });
    expect(refusal(check({ purpose: "wish" })).error).toBe("unsupported-type");
  });

  it("takes a site photo (the admin's own route, Task 19) as a photo up to 50 MB, and nothing else", () => {
    expect(check({ purpose: "site", contentType: "image/heic", filename: "IMG_0001.HEIC" })).toMatchObject({
      ok: true,
      kind: "photo",
      contentType: "image/heic",
      extension: "heic",
    });
    expect(refusal(check({ purpose: "site", contentType: "video/mp4", filename: "clip.mp4" }))).toEqual({
      error: "unsupported-type",
      message: "Only photos can be used here.",
    });
    expect(refusal(check({ purpose: "site", contentType: "image/svg+xml", filename: "logo.svg" })).error).toBe("unsupported-type");
    expect(refusal(check({ purpose: "site", size: 51 * 1024 * 1024 })).error).toBe("too-large");
  });

  it("Review Focus 5: refuses a PDF, an SVG, text, an empty type and anything else not on the list", () => {
    for (const [contentType, filename] of [
      ["application/pdf", "invitation.pdf"],
      ["image/svg+xml", "logo.svg"],
      ["image/svg+xml", "logo.png"],
      ["text/html", "page.html"],
      ["text/plain", "notes.txt"],
      ["application/zip", "photos.zip"],
      ["", "IMG_0001.JPG"],
      ["image/tiff", "scan.tif"],
      ["image/x-icon", "favicon.ico"],
      ["video/x-msvideo", "old.avi"],
      ["not a type", "photo.jpg"],
    ]) {
      expect(refusal(check({ contentType, filename })), `${contentType} ${filename}`).toEqual({
        error: "unsupported-type",
        message: "Only photos and videos can be shared here.",
      });
    }
  });

  it("refuses a .pdf, .svg, .exe or .html file whatever type it declares", () => {
    for (const filename of ["report.pdf", "logo.SVG", "setup.exe", "page.html", "page.htm"]) {
      expect(refusal(check({ filename })).error, filename).toBe("unsupported-type");
    }
    expect(refusal(check({ purpose: "wish", contentType: "audio/mpeg", filename: "song.exe" }))).toEqual({
      error: "unsupported-type",
      message: "Only voice and video recordings can be sent here.",
    });
  });

  it("accepts a HEIC a phone sent as application/octet-stream, only by its .heic or .heif name, as image/heic", () => {
    expect(check({ contentType: "application/octet-stream", filename: "IMG_4021.HEIC" })).toEqual({
      ok: true,
      kind: "photo",
      contentType: "image/heic",
      extension: "heic",
      partSize: PART_SIZE_BYTES,
      partCount: 1,
    });
    expect(check({ contentType: "application/octet-stream", filename: "photo.heif" })).toMatchObject({
      ok: true,
      contentType: "image/heic",
      extension: "heif",
    });
    expect(refusal(check({ contentType: "application/octet-stream", filename: "photo.jpg" })).error).toBe(
      "unsupported-type",
    );
    expect(refusal(check({ contentType: "application/octet-stream", filename: "photo" })).error).toBe(
      "unsupported-type",
    );
  });

  it("names the key by the declared type when the filename's extension disagrees, rather than refusing", () => {
    expect(check({ contentType: "video/quicktime", filename: "IMG_0001.jpg" })).toMatchObject({
      ok: true,
      kind: "video",
      extension: "mov",
    });
    expect(check({ contentType: "image/jpeg", filename: "photo.heic" })).toMatchObject({ extension: "jpg" });
    expect(check({ contentType: "image/png", filename: "no-extension" })).toMatchObject({ extension: "png" });
  });

  it("never takes a path, a dotted name or an odd extension from the filename", () => {
    for (const filename of ["../../originals/x.jpg/..", "a.tar.gz", "photo.j%2Fg", "photo.jpeg5", "photo.", "C:\\photos\\x"]) {
      const result = check({ filename });
      expect(result, filename).toMatchObject({ ok: true });
      if (result.ok) expect(result.extension, filename).toMatch(/^[a-z0-9]{1,5}$/);
    }
    expect(check({ filename: "C:\\Users\\Ama\\IMG_7.JPG" })).toMatchObject({ extension: "jpg" });
    expect(check({ filename: "../../evil.jpeg" })).toMatchObject({ extension: "jpeg" });
  });

  it("Review Focus 5: refuses an empty file with plain words", () => {
    expect(refusal(check({ size: 0 }))).toEqual({
      error: "empty-file",
      message: "This file is empty, so there's nothing to send. Please choose another.",
    });
  });

  it("Review Focus 5: refuses a file over its limit, naming the limit", () => {
    expect(check({ size: SIZE_LIMITS.photo })).toMatchObject({ ok: true, partCount: 7 });
    expect(refusal(check({ size: SIZE_LIMITS.photo + 1 }))).toEqual({
      error: "too-large",
      message: "This photo is over 50 MB, the most the album takes.",
    });
    const video = { contentType: "video/mp4", filename: "clip.mp4" };
    expect(check({ ...video, size: SIZE_LIMITS.video })).toMatchObject({ ok: true, partSize: LARGE_PART_SIZE_BYTES, partCount: 128 });
    expect(refusal(check({ ...video, size: SIZE_LIMITS.video + 1 }))).toEqual({
      error: "too-large",
      message: "This video is over 2 GB, the most the album takes. Please send a shorter clip.",
    });
    expect(refusal(check({ ...video, purpose: "wish", size: SIZE_LIMITS.videoWish + 1 }))).toEqual({
      error: "too-large",
      message: "This video message is over 400 MB, the most a wish takes.",
    });
    const voice = { purpose: "wish" as const, contentType: "audio/mp4", filename: "wish.m4a" };
    expect(check({ ...voice, size: SIZE_LIMITS.voiceWish })).toMatchObject({ ok: true });
    expect(refusal(check({ ...voice, size: SIZE_LIMITS.voiceWish + 1 }))).toEqual({
      error: "too-large",
      message: "This voice message is over 20 MB, the most a wish takes.",
    });
  });
});

describe("the album's gallery picker", () => {
  it("offers photos and videos by family, and HEIC by name, so a picker honouring one entry hides none of them", () => {
    expect(ALBUM_PICKER_ACCEPT.split(",")).toEqual(["image/*", "video/*", ".heic", ".heif"]);
    // Everything the album takes falls inside what the picker offers.
    for (const contentType of ["image/jpeg", "image/png", "image/heic", "image/webp", "video/mp4", "video/quicktime", "video/3gpp"]) {
      expect(check({ contentType }).ok, contentType).toBe(true);
      expect(contentType.startsWith("image/") || contentType.startsWith("video/")).toBe(true);
    }
  });
});

describe("normalizeContentType", () => {
  it("lowercases, trims and drops parameters", () => {
    expect(normalizeContentType(" Video/MP4; codecs=\"avc1.42E01E\" ")).toBe("video/mp4");
    expect(normalizeContentType("IMAGE/HEIC")).toBe("image/heic");
    expect(normalizeContentType("")).toBe("");
  });
});

describe("limits.ts's imports", () => {
  it("reach nothing but plain modules, so the worker can bundle it to re-check sizes", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./limits.ts", import.meta.url))],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
    });
    const external = Object.values(result.metafile.inputs).flatMap((input) =>
      input.imports.filter((imported) => imported.external).map((imported) => imported.path),
    );
    expect(external).toEqual([]);
  });
});
