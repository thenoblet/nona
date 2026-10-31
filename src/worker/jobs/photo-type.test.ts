import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { photoTypeOf } from "./photo-type";

const latin1 = (text: string) => Buffer.from(text, "latin1");

/** An ISO media file's first box: `ftyp`, with its major brand and compatible brands. */
function ftyp(major: string, ...compatible: string[]): Buffer {
  const size = 16 + 4 * compatible.length;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  box.write(compatible.join(""), 16, "latin1");
  return Buffer.concat([box, randomBytes(64)]);
}

function tiny() {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } });
}

describe("photoTypeOf: the album's photo formats, by their first bytes", () => {
  it("knows JPEG, PNG, GIF and WebP", async () => {
    expect(photoTypeOf(await tiny().jpeg().toBuffer())).toEqual({ ok: true, format: "jpeg" });
    expect(photoTypeOf(await tiny().png().toBuffer())).toEqual({ ok: true, format: "png" });
    expect(photoTypeOf(await tiny().gif().toBuffer())).toEqual({ ok: true, format: "gif" });
    expect(photoTypeOf(await tiny().webp().toBuffer())).toEqual({ ok: true, format: "webp" });
  });

  it("knows HEIC, HEIF and AVIF, by any of their brands", async () => {
    expect(photoTypeOf(ftyp("heic", "mif1", "heic"))).toEqual({ ok: true, format: "heif" });
    expect(photoTypeOf(ftyp("heix", "mif1"))).toEqual({ ok: true, format: "heif" });
    expect(photoTypeOf(ftyp("mif1", "heic", "miaf"))).toEqual({ ok: true, format: "heif" });
    expect(photoTypeOf(ftyp("avif", "mif1", "avif", "miaf"))).toEqual({ ok: true, format: "heif" });
    expect(photoTypeOf(await tiny().avif().toBuffer())).toEqual({ ok: true, format: "heif" });
  });
});

describe("photoTypeOf: a file that isn't a photo the album takes (Review Focus 5)", () => {
  it("calls a video, a document, a page or a program unsupported, whatever its name said", () => {
    const unsupported = {
      "an MP4 video": ftyp("isom", "isom", "iso2", "avc1", "mp41"),
      "an iPhone video": ftyp("qt  ", "qt  "),
      "an old QuickTime video": Buffer.concat([Buffer.from([0, 0, 0, 8]), latin1("wide"), randomBytes(32)]),
      "a 3GPP video": ftyp("3gp4", "isom", "3gp4"),
      "a WebM or Matroska video": Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(32)]),
      "an AVI video": Buffer.concat([latin1("RIFF"), randomBytes(4), latin1("AVI LIST"), randomBytes(16)]),
      "a PDF": latin1("%PDF-1.7\n%âãÏÓ\n1 0 obj"),
      "an SVG": latin1('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      "an SVG after a byte-order mark and spaces": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), latin1("\n  <svg></svg>")]),
      "an HTML page": latin1("<!doctype html><html><script>alert(1)</script>"),
      "a zip": Buffer.concat([latin1("PK\x03\x04"), randomBytes(32)]),
      "a Windows program": Buffer.concat([latin1("MZ"), randomBytes(32)]),
      "a Linux program": Buffer.concat([latin1("\x7fELF"), randomBytes(32)]),
      "a TIFF or camera raw": Buffer.concat([latin1("II*\0"), randomBytes(32)]),
      "a BMP": Buffer.concat([latin1("BM"), randomBytes(32)]),
      "an MP3": Buffer.concat([latin1("ID3"), randomBytes(32)]),
      "an Ogg recording": Buffer.concat([latin1("OggS"), randomBytes(32)]),
      "a WAV recording": Buffer.concat([latin1("RIFF"), randomBytes(4), latin1("WAVEfmt "), randomBytes(16)]),
      "a JPEG XL": Buffer.concat([Buffer.from([0xff, 0x0a]), randomBytes(32)]),
    };
    for (const [what, head] of Object.entries(unsupported)) {
      expect(photoTypeOf(head), what).toMatchObject({ ok: false, reason: "unsupported-type" });
    }
  });

  it("calls bytes of no known format, or none at all, corrupt", () => {
    // Random bytes that happen to start like a known format would be named after it; these don't.
    const random = Buffer.concat([Buffer.from([0x13, 0x37, 0x00, 0x42, 0x99, 0x01, 0x02, 0x03]), randomBytes(4088)]);
    expect(photoTypeOf(random)).toMatchObject({ ok: false, reason: "corrupt" });
    expect(photoTypeOf(new Uint8Array(0))).toMatchObject({ ok: false, reason: "corrupt" });
    expect(photoTypeOf(Buffer.from([0xff, 0xd8]))).toMatchObject({ ok: false, reason: "corrupt" });
  });

  it("names what it found in words, never echoing the file's bytes", () => {
    const check = photoTypeOf(latin1("%PDF-1.7 secret"));
    expect(check).toMatchObject({ ok: false, found: "a PDF" });
  });
});
