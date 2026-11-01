import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import exifr from "exifr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { captureTimeExif, keepOnlyCaptureTime, MAX_HEADER_BYTES } from "./jpeg-metadata";

/*
 * The full-size JPEG of a HEIC goes to the public bucket, so it carries no location (global
 * constraints: derived files hold no location data). heif-dec writes the HEIC's EXIF into it, GPS
 * and all; the filter takes every metadata segment out without decoding a pixel, and writes back
 * only the capture time, so a phone's gallery files it on the right day.
 */

/** A JPEG as heif-dec writes one: its EXIF (with GPS), XMP, a comment and an ICC profile. */
async function jpegWithEverything(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 60, b: 50 } } })
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 15", Orientation: "6" },
      IFD2: { DateTimeOriginal: "2026:12:05 19:42:07", OffsetTimeOriginal: "+00:00" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 50/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "1/1 59/1 0/1" },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="6,50N"/></rdf:RDF></x:xmpmeta>')
    .withIccProfile("p3")
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** The bytes, filtered as they stream in `chunkSize`-byte pieces. */
async function filtered(bytes: Buffer, capturedAt: Date | null, chunkSize = 7): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += chunkSize) pieces.push(bytes.subarray(at, at + chunkSize));
  return buffer(Readable.from(pieces).pipe(keepOnlyCaptureTime(capturedAt)));
}

/** The markers of the JPEG's segments before its scan. */
function headerMarkers(bytes: Buffer): number[] {
  const markers: number[] = [];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    markers.push(marker);
    if (marker === 0xda) break;
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return markers;
}

describe("keepOnlyCaptureTime", () => {
  it("takes out the EXIF (GPS and all), the XMP and comments, keeps the picture and its colours, and writes back only when it was taken", async () => {
    const original = await jpegWithEverything();
    expect((await exifr.parse(original, { gps: true }))?.latitude).toBeCloseTo(6.833, 2);
    const capturedAt = new Date("2026-12-05T19:42:07Z");

    const clean = await filtered(original, capturedAt);

    expect((await exifr.gps(clean).catch(() => undefined)) ?? undefined).toBeUndefined();
    const tags = await exifr.parse(clean, { xmp: true, icc: false, tiff: true, exif: true, gps: true, reviveValues: false });
    expect(tags).toEqual({ DateTimeOriginal: "2026:12:05 19:42:07", OffsetTimeOriginal: "+00:00" });
    expect(clean.includes(Buffer.from("xmpmeta"))).toBe(false);
    expect(clean.includes(Buffer.from("iPhone"))).toBe(false);
    // The ICC profile stays (no location in it), and the pixels are exactly as they were.
    expect((await sharp(clean).metadata()).icc).toBeDefined();
    expect(await sharp(clean).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
    // Orientation went with the EXIF: heif-dec's pixels are upright already.
    expect((await sharp(clean).metadata()).orientation).toBeUndefined();
    // One APP1, the capture time's, straight after SOI (or after JFIF's APP0, which must come first).
    const markers = headerMarkers(clean);
    expect(markers.filter((marker) => marker === 0xe1)).toHaveLength(1);
    expect(markers.indexOf(0xe1)).toBe(markers[0] === 0xe0 ? 1 : 0);
  });

  it("writes no EXIF at all when the capture time is unknown, and streams a large file through untouched past its header", async () => {
    const original = await jpegWithEverything();
    const clean = await filtered(original, null, 1);
    expect(headerMarkers(clean)).not.toContain(0xe1);
    expect(await exifr.parse(clean).catch(() => undefined)).toBeUndefined();
    const scanStart = original.indexOf(Buffer.from([0xff, 0xda]));
    expect(clean.subarray(clean.indexOf(Buffer.from([0xff, 0xda])))).toEqual(original.subarray(scanStart));
  });

  it("passes over the fill bytes a JPEG may put before a marker", async () => {
    const original = await jpegWithEverything();
    // Three 0xFF fill bytes before the second segment.
    const second = 2 + 2 + original.readUInt16BE(4);
    const padded = Buffer.concat([original.subarray(0, second), Buffer.from([0xff, 0xff, 0xff]), original.subarray(second)]);
    const clean = await filtered(padded, null, 5);
    expect(await sharp(clean).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
    expect(await exifr.gps(clean).catch(() => undefined)).toBeUndefined();
  });

  it("passes over fill bytes right before the scan, writing its start once (fix round 1, Minor #7)", async () => {
    const original = await jpegWithEverything();
    const scanAt = original.indexOf(Buffer.from([0xff, 0xda]));
    const padded = Buffer.concat([original.subarray(0, scanAt), Buffer.from([0xff, 0xff]), original.subarray(scanAt)]);
    const clean = await filtered(padded, new Date("2026-12-05T19:42:07Z"), 3);
    expect(headerMarkers(clean).filter((marker) => marker === 0xda)).toHaveLength(1);
    const scans = clean.toString("latin1").split(String.fromCharCode(0xff, 0xda)).length - 1;
    expect(scans).toBe(original.toString("latin1").split(String.fromCharCode(0xff, 0xda)).length - 1);
    expect(await sharp(clean).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer());
  });

  it("refuses what isn't a JPEG, and a header past MAX_HEADER_BYTES, rather than pass it on", async () => {
    await expect(filtered(Buffer.from("not a jpeg at all"), null)).rejects.toThrow(/not a JPEG/);
    const endless = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: Math.ceil(MAX_HEADER_BYTES / 65_000) + 1 }, () => {
      const segment = Buffer.alloc(65_002);
      segment.writeUInt16BE(0xfffe, 0);
      segment.writeUInt16BE(65_000, 2);
      return segment;
    })]);
    await expect(filtered(endless, null, 65_536)).rejects.toThrow(/header/);
  });

  it("builds a capture time EXIF segment exifr reads back, in Accra's time (UTC, no daylight saving)", async () => {
    const segment = captureTimeExif(new Date("2026-12-06T09:05:03.900Z"));
    expect(segment.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xe1]));
    expect(segment.readUInt16BE(2)).toBe(segment.length - 2);
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer();
    const withTime = Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
    expect(await exifr.parse(withTime, { reviveValues: false })).toEqual({ DateTimeOriginal: "2026:12:06 09:05:03", OffsetTimeOriginal: "+00:00" });
  });
});
