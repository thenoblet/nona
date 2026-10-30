import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureTimeFromExif, readPhotoCaptureTime } from "./capture-time";

describe("captureTimeFromExif", () => {
  it("reads DateTimeOriginal with its OffsetTimeOriginal", () => {
    const capturedAt = captureTimeFromExif({ DateTimeOriginal: "2026:12:06 01:00:00", OffsetTimeOriginal: "+02:00" });
    expect(capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
  });

  it("takes OffsetTime when the photo has no OffsetTimeOriginal", () => {
    const capturedAt = captureTimeFromExif({ DateTimeOriginal: "2026:12:05 08:15:30", OffsetTime: "-05:30" });
    expect(capturedAt?.toISOString()).toBe("2026-12-05T13:45:30.000Z");
  });

  it("prefers OffsetTimeOriginal to OffsetTime", () => {
    const capturedAt = captureTimeFromExif({
      DateTimeOriginal: "2026:12:05 12:00:00",
      OffsetTimeOriginal: "+01:00",
      OffsetTime: "+09:00",
    });
    expect(capturedAt?.toISOString()).toBe("2026-12-05T11:00:00.000Z");
  });

  it("reads a time with no offset as Accra's, which is UTC, whatever the machine's own zone", () => {
    expect(captureTimeFromExif({ DateTimeOriginal: "2026:12:05 10:30:00" })?.toISOString()).toBe("2026-12-05T10:30:00.000Z");
  });

  it("reads an offset it can't make sense of as no offset: Accra", () => {
    for (const offset of ["", "   :  ", "+2", "+15:00", "+02:75", 7200]) {
      const capturedAt = captureTimeFromExif({ DateTimeOriginal: "2026:12:05 10:30:00", OffsetTimeOriginal: offset });
      expect(capturedAt?.toISOString(), String(offset)).toBe("2026-12-05T10:30:00.000Z");
    }
  });

  it("finds no time in a missing, blank, zeroed or impossible date", () => {
    for (const value of [undefined, null, "", "    :  :     :  :  ", "0000:00:00 00:00:00", "2026:02:30 10:00:00", "2026:12:05 24:00:00", "yesterday", 1764930600]) {
      expect(captureTimeFromExif({ DateTimeOriginal: value }), String(value)).toBeNull();
    }
  });
});

describe("readPhotoCaptureTime", () => {
  let folder: string;

  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), "nona-capture-time-"));
  });

  afterAll(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  function blank() {
    return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 120, b: 150 } } });
  }

  it("reads a JPEG's EXIF capture time and offset", async () => {
    const path = join(folder, "with-offset.jpg");
    await blank()
      .withExif({ IFD2: { DateTimeOriginal: "2026:12:06 01:00:00", OffsetTimeOriginal: "+02:00" } })
      .jpeg()
      .toFile(path);
    expect((await readPhotoCaptureTime(path))?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
  });

  it("reads a JPEG's EXIF capture time without an offset as Accra's", async () => {
    const path = join(folder, "no-offset.jpg");
    await blank().withExif({ IFD2: { DateTimeOriginal: "2026:12:05 10:30:00" } }).jpeg().toFile(path);
    expect((await readPhotoCaptureTime(path))?.toISOString()).toBe("2026-12-05T10:30:00.000Z");
  });

  it("finds none in a photo without EXIF, a format EXIF readers don't know, or bytes that are no image", async () => {
    const png = join(folder, "plain.png");
    await blank().png().toFile(png);
    const webp = join(folder, "plain.webp");
    await blank().webp().toFile(webp);
    const random = join(folder, "random.jpg");
    await writeFile(random, randomBytes(4096));

    expect(await readPhotoCaptureTime(png)).toBeNull();
    expect(await readPhotoCaptureTime(webp)).toBeNull();
    expect(await readPhotoCaptureTime(random)).toBeNull();
    expect(await readPhotoCaptureTime(join(folder, "missing.jpg"))).toBeNull();
  });
});
