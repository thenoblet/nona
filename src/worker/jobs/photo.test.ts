import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { crc32 } from "node:zlib";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import exifr from "exifr";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { PermanentJobError, startQueueWorkers, type MediaJob, type QueueWorkers } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { ProcessError } from "../processes";
import {
  heifImagesIn,
  heifToolFailure,
  photoHandler,
  processPhoto,
  sharpFailure,
  type PhotoOptions,
} from "./photo";

/*
 * media.photo against the local MinIO and test database (docker compose up -d db minio && npm run
 * storage:init). Every fixture is made here, in setup, except Noblet's own iPhone photo
 * (test/fixtures/iphone.heic), which is committed once it arrives (Ruling F). The HEIC tests need
 * libheif's heif-enc and heif-dec: the worker image's test target has both, and requires them.
 */

// A test can act between the photo's derived files going up and its row being marked (Ruling AG).
const publishing = vi.hoisted(() => ({ afterPut: null as null | (() => Promise<void>) }));
vi.mock("@/lib/storage/objects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/objects")>();
  return {
    ...real,
    putPublicObject: async (...args: Parameters<typeof real.putPublicObject>) => {
      await real.putPublicObject(...args);
      const afterPut = publishing.afterPut;
      publishing.afterPut = null;
      await afterPut?.();
    },
  };
});

// Every program the job runs, so a test can tell whether heif-dec ran and under which memory cap.
const programs = vi.hoisted(() => ({ runs: [] as string[][] }));
vi.mock("../processes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../processes")>();
  return {
    ...real,
    runProcess: (...args: Parameters<typeof real.runProcess>) => {
      programs.runs.push([args[0], ...args[1]]);
      return real.runProcess(...args);
    },
  };
});

/** The production defaults: heif-dec capped at WORKER_HEIF_MEMORY_BYTES's, on WORKER_HEIF_THREADS's. */
const PHOTO_OPTIONS: PhotoOptions = {
  heifMemoryBytes: workerConfig({}).heifMemoryBytes,
  heifThreads: workerConfig({}).threads.heif,
};

/** The programs run since the test began whose arguments include `program`. */
function runsOf(program: string): string[][] {
  return programs.runs.filter((run) => run.includes(program));
}

// A test can make the manifest's writes fail a few times, as R2 might.
const manifests = vi.hoisted(() => ({ failuresLeft: 0 }));
vi.mock("@/lib/storage/manifest", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/manifest")>();
  return {
    ...real,
    writeManifest: async (...args: Parameters<typeof real.writeManifest>) => {
      if (manifests.failuresLeft > 0) {
        manifests.failuresLeft -= 1;
        throw new Error("R2 answered 503 Slow Down");
      }
      return real.writeManifest(...args);
    },
  };
});

const runFile = promisify(execFile);

async function hasProgram(name: string): Promise<boolean> {
  return runFile(name, ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
}

// In the worker image the HEIC tests always run; elsewhere only where libheif's tools are installed.
const heicTests =
  process.env.WORKER_TEST_IMAGE === "1" || ((await hasProgram("heif-enc")) && (await hasProgram("heif-dec")));
const IPHONE_SAMPLE = new URL("../../../test/fixtures/iphone.heic", import.meta.url);

let folder: string;
let sharpThreads: number;
const privateKeys: string[] = [];

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "nona-photo-test-"));
  await prepareScratchRoot(join(folder, "scratch"));
  // One libvips thread per photo, as production sets it (WORKER_SHARP_THREADS, Ruling R).
  sharpThreads = sharp.concurrency();
  sharp.concurrency(1);
});

afterAll(async () => {
  sharp.concurrency(sharpThreads);
  await rm(folder, { recursive: true, force: true });
  const { privateBucket } = storageConfig();
  for (let start = 0; start < privateKeys.length; start += 1000) {
    const batch = privateKeys.slice(start, start + 1000);
    await storageClient().send(
      new DeleteObjectsCommand({ Bucket: privateBucket, Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true } }),
    );
  }
});

beforeEach(async () => {
  await resetDb();
  publishing.afterPut = null;
  programs.runs = [];
  manifests.failuresLeft = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
});

/** The public bucket's keys under an item's folder. */
async function publicKeysOf(mediaId: string): Promise<string[]> {
  const listing = await storageClient().send(
    new ListObjectsV2Command({ Bucket: storageConfig().publicBucket, Prefix: `derived/${mediaId}/` }),
  );
  return (listing.Contents ?? []).map((object) => object.Key ?? "");
}

async function readPublic(key: string) {
  const response = await storageClient().send(new GetObjectCommand({ Bucket: storageConfig().publicBucket, Key: key }));
  return {
    bytes: Buffer.from((await response.Body?.transformToByteArray()) ?? []),
    contentType: response.ContentType,
    cacheControl: response.CacheControl,
  };
}

/** Puts the bytes in the private bucket as an original, with its row `uploaded` as the upload API leaves it. */
async function uploadedPhoto(
  bytes: Uint8Array,
  extension: string,
  values: Partial<typeof media.$inferInsert> = {},
): Promise<string> {
  const id = values.id ?? randomUUID();
  const key = originalKey(id, extension);
  privateKeys.push(key, `manifests/${id}.json`);
  await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: bytes }));
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "photo",
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "more",
      originalKey: key,
      originalFilename: `IMG_0001.${extension.toUpperCase()}`,
      sizeBytes: bytes.length,
      contentType: extension === "heic" ? "image/heic" : `image/${extension === "jpg" ? "jpeg" : extension}`,
      status: "uploaded",
      startedAt: new Date("2026-12-07T12:00:00Z"),
      uploadedAt: new Date("2026-12-07T12:01:00Z"),
      ...values,
    });
  return id;
}

function photoJob(mediaId: string): MediaJob {
  return {
    id: randomUUID(),
    queue: MEDIA_QUEUES.photo,
    data: { mediaId },
    signal: AbortSignal.timeout(120_000),
    retryCount: 0,
  };
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

async function sizeOf(bytes: Uint8Array) {
  const { width, height, format } = await sharp(bytes).metadata();
  return { width, height, format };
}

/** The colour at a point of an image, given as fractions of its width and height. */
async function colourAt(bytes: Uint8Array, acrossFraction: number, downFraction: number): Promise<number[]> {
  const { data, info } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const column = Math.min(info.width - 1, Math.floor(info.width * acrossFraction));
  const row = Math.min(info.height - 1, Math.floor(info.height * downFraction));
  const offset = (row * info.width + column) * info.channels;
  return Array.from(data.subarray(offset, offset + 3));
}

function isBlue([red, green, blue]: number[]): boolean {
  return blue > 200 && red < 60 && green < 60;
}

/**
 * A photo as a phone stores it: landscape pixels, `width` × `height`, with a blue band down their
 * left side, and EXIF that says how to turn them (orientation 6: a quarter turn clockwise, so
 * upright the band runs along the top), when it was taken, and where (GPS).
 */
function phonePhoto(width: number, height: number, orientation = 6) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 50 } } })
    .composite([
      {
        input: { create: { width: Math.round(width / 4), height, channels: 3, background: { r: 0, g: 0, b: 255 } } },
        left: 0,
        top: 0,
      },
    ])
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 15" },
      IFD2: { DateTimeOriginal: "2026:12:06 01:00:00", OffsetTimeOriginal: "+02:00" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 50/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "1/1 59/1 0/1" },
    })
    .withMetadata({ orientation });
}

/** A HEIC made from the JPEG by libheif's encoder, which turns its EXIF orientation into the HEIF's own rotation (irot). */
async function heicFrom(...jpegs: Buffer[]): Promise<Buffer> {
  const name = randomUUID();
  const inputs = await Promise.all(
    jpegs.map(async (jpeg, index) => {
      const path = join(folder, `${name}-${index}.jpg`);
      await writeFile(path, jpeg);
      return path;
    }),
  );
  const output = join(folder, `${name}.heic`);
  await runFile("heif-enc", ["--quality", "60", "--output", output, ...inputs], { timeout: 120_000 });
  return readFile(output);
}

/**
 * The HEIC with one image's size, as its header (its `ispe` property) gives it, changed from `from`
 * to `to`: a file that claims what it doesn't hold, as a crafted one would.
 */
function claimingSize(heic: Buffer, from: [number, number], to: [number, number]): Buffer {
  const crafted = Buffer.from(heic);
  for (let at = crafted.indexOf("ispe", 0, "latin1"); at !== -1; at = crafted.indexOf("ispe", at + 1, "latin1")) {
    if (crafted.readUInt32BE(at + 8) === from[0] && crafted.readUInt32BE(at + 12) === from[1]) {
      crafted.writeUInt32BE(to[0], at + 8);
      crafted.writeUInt32BE(to[1], at + 12);
      return crafted;
    }
  }
  throw new Error(`No image of ${from.join(" × ")} in the HEIC`);
}

/** The HEIC with its primary image (its `pitm` box) changed to the item `itemId`. */
function withPrimary(heic: Buffer, itemId: number): Buffer {
  const patched = Buffer.from(heic);
  const box = patched.indexOf("pitm", 0, "latin1");
  if (box === -1) throw new Error("No pitm box in the HEIC");
  // Version 0 holds a 16-bit item id, version 1 a 32-bit one, after the version and flags.
  if (patched[box + 4] === 0) patched.writeUInt16BE(itemId, box + 8);
  else patched.writeUInt32BE(itemId, box + 8);
  return patched;
}

/**
 * A 12 MP JPEG with as much detail as a busy photo: noise made at a quarter of its size and
 * enlarged, so it survives at the thumbnail's scale instead of averaging out.
 */
async function twelveMegapixelPhoto(): Promise<Buffer> {
  const detail = await sharp({
    create: { width: 1008, height: 756, channels: 3, background: { r: 120, g: 110, b: 100 }, noise: { type: "gaussian", mean: 120, sigma: 40 } },
  })
    .png()
    .toBuffer();
  return sharp(detail).resize(4032, 3024, { kernel: "cubic" }).jpeg({ quality: 90 }).toBuffer();
}

describe("a photo's derived files", () => {
  it("are a thumbnail and a viewing size by the long edge, a ThumbHash and the dimensions, and the item turns ready", async () => {
    const jpeg = await phonePhoto(2000, 1500, 1).jpeg().toBuffer();
    const mediaId = await uploadedPhoto(jpeg, "jpg");

    const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", failureReason: null, width: 2000, height: 1500 });
    expect(item.listedAt).toBeInstanceOf(Date);
    expect(item.thumbhash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(item.averageColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(item.derived.thumb).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/thumb\\.webp$`));
    expect(item.derived.view).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/view\\.webp$`));
    expect((await publicKeysOf(mediaId)).sort()).toEqual([item.derived.thumb, item.derived.view].sort());

    const thumb = await readPublic(item.derived.thumb ?? "");
    const view = await readPublic(item.derived.view ?? "");
    expect(await sizeOf(thumb.bytes)).toEqual({ width: 480, height: 360, format: "webp" });
    expect(await sizeOf(view.bytes)).toEqual({ width: 1600, height: 1200, format: "webp" });
    expect(thumb.contentType).toBe("image/webp");
    expect(thumb.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(report).toEqual({ sizeBytes: jpeg.length, kind: "photo/jpeg" });
  });

  it("turn a JPEG with EXIF orientation 6 into an upright portrait thumbnail", async () => {
    const mediaId = await uploadedPhoto(await phonePhoto(1200, 900).jpeg().toBuffer(), "jpg");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 900, height: 1200 });
    const thumb = (await readPublic(item.derived.thumb ?? "")).bytes;
    expect(await sizeOf(thumb)).toEqual({ width: 360, height: 480, format: "webp" });
    // Turned a quarter clockwise, the band on the stored pixels' left runs along the top.
    expect(isBlue(await colourAt(thumb, 0.5, 0.05))).toBe(true);
    expect(isBlue(await colourAt(thumb, 0.05, 0.5))).toBe(false);
    expect(await sizeOf((await readPublic(item.derived.view ?? "")).bytes)).toEqual({ width: 900, height: 1200, format: "webp" });
  });

  it("are made from a PNG too, with transparency, and never enlarged past the original", async () => {
    const png = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 30, g: 140, b: 60, alpha: 0.5 } } })
      .png()
      .toBuffer();
    const mediaId = await uploadedPhoto(png, "png");

    const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 800, height: 600 });
    expect(await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes)).toEqual({ width: 480, height: 360, format: "webp" });
    expect(await sizeOf((await readPublic(item.derived.view ?? "")).bytes)).toEqual({ width: 800, height: 600, format: "webp" });
    expect(report).toMatchObject({ kind: "photo/png" });
  });

  it("are made from every other format the album takes: GIF (its first frame), WebP and AVIF", async () => {
    const frames = await Promise.all(
      ["#f00", "#0f0"].map((colour) => sharp({ create: { width: 600, height: 400, channels: 3, background: colour } }).png().toBuffer()),
    );
    const scene = sharp({ create: { width: 600, height: 400, channels: 3, background: "#468" } });
    const files = {
      gif: await sharp(frames, { join: { animated: true } }).gif({ loop: 0 }).toBuffer(),
      webp: await scene.clone().webp().toBuffer(),
      avif: await scene.clone().avif().toBuffer(),
    };
    for (const [format, bytes] of Object.entries(files)) {
      const mediaId = await uploadedPhoto(bytes, format);

      const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

      const item = await readItem(mediaId);
      expect(item, format).toMatchObject({ status: "ready", width: 600, height: 400 });
      expect(await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes), format).toEqual({ width: 480, height: 320, format: "webp" });
      expect(report, format).toMatchObject({ kind: `photo/${format}` });
    }
  });

  it("carry no EXIF and no location, though the original has both", async () => {
    const jpeg = await phonePhoto(1200, 900).jpeg().toBuffer();
    expect(await exifr.gps(jpeg)).toMatchObject({ latitude: expect.any(Number) });
    const mediaId = await uploadedPhoto(jpeg, "jpg");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    for (const key of [item.derived.thumb ?? "", item.derived.view ?? ""]) {
      const { bytes } = await readPublic(key);
      const metadata = await sharp(bytes).metadata();
      expect(metadata.exif, key).toBeUndefined();
      expect(metadata.xmp, key).toBeUndefined();
      expect(bytes.includes(Buffer.from("Exif")), key).toBe(false);
      expect(await exifr.gps(bytes).catch(() => undefined), key).toBeUndefined();
    }
  });

  it("keep a 12 MP photo's thumbnail under 60 KB, ready well inside the 20 s budget on one sharp thread", async () => {
    const jpeg = await twelveMegapixelPhoto();
    const mediaId = await uploadedPhoto(jpeg, "jpg");

    const startedAt = performance.now();
    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);
    const milliseconds = performance.now() - startedAt;

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 4032, height: 3024 });
    const thumb = (await readPublic(item.derived.thumb ?? "")).bytes;
    expect(thumb.length).toBeLessThan(60 * 1024);
    expect(milliseconds).toBeLessThan(10_000);
  });

  it("are made from a 200 MP JPEG, a Galaxy Ultra's high-resolution mode (Ruling AK)", async () => {
    const jpeg = await sharp({ create: { width: 16_320, height: 12_240, channels: 3, background: "#7a5" } })
      .composite([{ input: { create: { width: 4_080, height: 12_240, channels: 3, background: "#00f" } }, left: 0, top: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();
    const mediaId = await uploadedPhoto(jpeg, "jpg");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 16_320, height: 12_240 });
    const view = (await readPublic(item.derived.view ?? "")).bytes;
    expect(await sizeOf(view)).toEqual({ width: 1600, height: 1200, format: "webp" });
    expect(isBlue(await colourAt(view, 0.05, 0.5))).toBe(true);
  });
});

describe("a photo's capture time and celebration", () => {
  it("are read from the EXIF, with its offset, and the celebration assigned again from that time", async () => {
    // 01:00 on Sunday at +02:00 is 23:00 on Saturday in Accra: the reception, not the thanksgiving.
    const mediaId = await uploadedPhoto(await phonePhoto(1200, 900).jpeg().toBuffer(), "jpg", { celebration: "more" });

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    expect(item.celebration).toBe("reception");
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "reception", celebrationSetByAdmin: false });
  });

  it("read a time with no offset as Accra's", async () => {
    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#456" } })
      .withExif({ IFD2: { DateTimeOriginal: "2026:12:05 10:30:00" } })
      .jpeg()
      .toBuffer();
    const mediaId = await uploadedPhoto(jpeg, "jpg");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T10:30:00.000Z");
    expect(item.celebration).toBe("ceremony");
  });

  it("keep the celebration the couple moved the item to", async () => {
    const mediaId = await uploadedPhoto(await phonePhoto(1200, 900).jpeg().toBuffer(), "jpg", {
      celebration: "thanks",
      celebrationSetByAdmin: true,
    });

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", celebration: "thanks", celebrationSetByAdmin: true });
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
  });

  it("fall back to the time the phone sent when the file has none", async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#654" } }).png().toBuffer();
    const mediaId = await uploadedPhoto(png, "png", { capturedAt: new Date("2026-12-05T11:00:00Z") });

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T11:00:00.000Z");
    expect(item.celebration).toBe("ceremony");
  });

  it("drop a time from a reset or wrong clock (before 2000, or past the day after the upload), and use the phone's", async () => {
    // The upload started during the ceremony; the phone sent the time it was taken.
    const startedAt = new Date("2026-12-05T11:00:00Z");
    for (const taken of ["1970:01:01 00:00:00", "2099:01:01 12:00:00"]) {
      const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#456" } })
        .withExif({ IFD2: { DateTimeOriginal: taken } })
        .jpeg()
        .toBuffer();
      const mediaId = await uploadedPhoto(jpeg, "jpg", { startedAt, capturedAt: new Date("2026-12-05T15:00:00Z") });

      await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

      const item = await readItem(mediaId);
      expect(item.capturedAt?.toISOString(), taken).toBe("2026-12-05T15:00:00.000Z");
      expect(item.celebration, taken).toBe("reception");
    }
  });

  it("drop the phone's time too when its clock is wrong, and group by when the upload started", async () => {
    const startedAt = new Date("2026-12-05T11:00:00Z");
    for (const phoneTime of [new Date("1970-01-01T00:00:00Z"), new Date("2099-01-01T12:00:00Z")]) {
      const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#654" } }).png().toBuffer();
      const mediaId = await uploadedPhoto(png, "png", { startedAt, capturedAt: phoneTime });

      await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

      const item = await readItem(mediaId);
      expect(item.capturedAt, phoneTime.toISOString()).toBeNull();
      expect(item.celebration, phoneTime.toISOString()).toBe("ceremony");
    }
  });

  it("leave an item listed before in its place in the album", async () => {
    const listedAt = new Date("2026-12-05T12:00:00Z");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } }).png().toBuffer();
    const mediaId = await uploadedPhoto(png, "png", { listedAt });

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    expect((await readItem(mediaId)).listedAt?.toISOString()).toBe(listedAt.toISOString());
  });
});

describe("heifImagesIn: heif-info's list of a HEIC's images", () => {
  it("reads each top-level image's size and which is the primary, past the thumbnails and the rest", () => {
    const listing = [
      "MIME type: image/heic",
      "main brand: heic",
      "compatible brands: mif1, heic, miaf",
      "",
      "image: 4032x3024 (id=49), primary",
      "  colorspace: YCbCr, 4:2:0",
      "  thumbnails:",
      "    image: 320x240 (id=50)",
      "  depth channel: yes",
      "image: 800x600 (id=60)",
    ].join("\n");
    expect(heifImagesIn(listing)).toEqual([
      { width: 4032, height: 3024, primary: true },
      { width: 800, height: 600, primary: false },
    ]);
  });

  it("finds nothing in a list it can't read: no image, an image line it doesn't know, or no primary", () => {
    expect(heifImagesIn("")).toBeNull();
    expect(heifImagesIn("MIME type: unknown\nmain brand: ")).toBeNull();
    expect(heifImagesIn("image: 4032x3024 (id=49), primary\nimage: lots (id=50)")).toBeNull();
    expect(heifImagesIn("image: 4032x3024 (id=49)\nimage: 800x600 (id=60)")).toBeNull();
    expect(heifImagesIn("image: 4032x3024 (id=49), primary\nimage: 800x600 (id=60), primary")).toBeNull();
  });
});

describe("what a failure is: the file's, for good, or the worker's, to try again", () => {
  const memoryBytes = 2 * 1024 ** 3;
  const failure = (ending: ConstructorParameters<typeof ProcessError>[1], exitCode: number | null, exitSignal: NodeJS.Signals | null = null) =>
    heifToolFailure("heif-dec", new ProcessError("prlimit", ending, exitCode, "Could not decode image", exitSignal), memoryBytes);

  it("blames the file when heif-dec refuses it, dies on it, runs past its time or prints far too much", () => {
    for (const error of [failure("exit", 1), failure("exit", null, "SIGABRT"), failure("exit", null, "SIGSEGV"), failure("timeout", null, "SIGKILL"), failure("too-much-output", null, "SIGKILL")]) {
      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).reason).toBe("corrupt");
    }
  });

  it("tries again when something else killed heif-dec (an OOM kill from a conversion beside it), the job ended, the worker stopped, or the tool couldn't run", () => {
    const spawnError = Object.assign(new Error("spawn prlimit ENOENT"), { code: "ENOENT" });
    for (const error of [
      failure("exit", null, "SIGKILL"),
      failure("aborted", null, "SIGKILL"),
      failure("stopping", null, "SIGKILL"),
      failure("exit", 127),
      failure("exit", 126),
      heifToolFailure("heif-dec", spawnError, memoryBytes),
    ]) {
      expect(error).not.toBeInstanceOf(PermanentJobError);
    }
  });

  it("blames the file for sharp's decode errors and pixel limit, and the worker for running out of memory, files or disk", () => {
    expect(sharpFailure("jpeg", new Error("VipsJpeg: premature end of JPEG image"))).toMatchObject({ reason: "corrupt" });
    expect(sharpFailure("png", new Error("Input image exceeds pixel limit"))).toMatchObject({ reason: "too-large" });
    for (const message of [
      "vips_malloc: out of memory --- size == 600MB",
      "std::bad_alloc",
      "VipsJpeg: Cannot allocate memory",
      "unable to open for read: Too many open files",
      "VipsForeignSaveWebp: write error: No space left on device",
      "EMFILE: too many open files",
      "ENOSPC: no space left on device, write",
    ]) {
      expect(sharpFailure("jpeg", new Error(message)), message).not.toBeInstanceOf(PermanentJobError);
    }
  });
});

describe("HEIC (Review Focus 2)", () => {
  it.skipIf(!existsSync(IPHONE_SAMPLE))(
    "Noblet's real iPhone HEIC (test/fixtures/iphone.heic, pending until it arrives) gives an upright thumbnail with the photo's shape",
    async () => {
      const heic = await readFile(IPHONE_SAMPLE);
      // libheif reports the photo's size after its own rotation: the shape it is seen in.
      const upright = await sharp(heic).metadata();
      const mediaId = await uploadedPhoto(heic, "heic");

      const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

      const item = await readItem(mediaId);
      expect(item).toMatchObject({ status: "ready", width: upright.width, height: upright.height });
      expect(item.capturedAt).toBeInstanceOf(Date);
      const thumb = await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes);
      expect(Math.max(thumb.width ?? 0, thumb.height ?? 0)).toBe(480);
      expect((thumb.width ?? 0) / (thumb.height ?? 1)).toBeCloseTo((upright.width ?? 0) / (upright.height ?? 1), 1);
      expect(report).toMatchObject({ kind: "photo/heic" });
    },
  );

  it.skipIf(!heicTests)("turns a HEIC whose pixels the file says to rotate into an upright portrait thumbnail, with its capture time", async () => {
    const heic = await heicFrom(await phonePhoto(1200, 900).jpeg({ quality: 90 }).toBuffer());
    const mediaId = await uploadedPhoto(heic, "heic");

    const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 900, height: 1200, celebration: "reception" });
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    const thumb = (await readPublic(item.derived.thumb ?? "")).bytes;
    expect(await sizeOf(thumb)).toEqual({ width: 360, height: 480, format: "webp" });
    expect(isBlue(await colourAt(thumb, 0.5, 0.05))).toBe(true);
    expect(isBlue(await colourAt(thumb, 0.05, 0.5))).toBe(false);
    for (const key of [item.derived.thumb ?? "", item.derived.view ?? ""]) {
      expect(await exifr.gps((await readPublic(key)).bytes).catch(() => undefined), key).toBeUndefined();
    }
    expect(report).toEqual({ sizeBytes: heic.length, kind: "photo/heic" });
    // heif-info listed its images first, and heif-dec ran under the memory cap.
    expect(runsOf("heif-info")).toHaveLength(1);
    expect(runsOf("heif-dec")).toEqual([
      expect.arrayContaining(["prlimit", `--as=${PHOTO_OPTIONS.heifMemoryBytes}`, "--", "heif-dec"]),
    ]);
    // On WORKER_HEIF_THREADS threads, never libheif's own count (Ruling R).
    const [decode] = runsOf("heif-dec");
    for (const flag of ["--codec-threads", "--tile-threads"]) {
      expect(decode[decode.indexOf(flag) + 1], flag).toBe(String(PHOTO_OPTIONS.heifThreads));
    }
  });

  it.skipIf(!heicTests)("takes the primary image of a HEIC that holds several", async () => {
    const heic = await heicFrom(
      await phonePhoto(1200, 900).jpeg({ quality: 90 }).toBuffer(),
      await sharp({ create: { width: 800, height: 200, channels: 3, background: "#0f0" } }).jpeg().toBuffer(),
    );
    const mediaId = await uploadedPhoto(heic, "heic");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 900, height: 1200 });
    expect(await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes)).toEqual({ width: 360, height: 480, format: "webp" });
  });

  it.skipIf(!heicTests)("takes the primary image when it isn't the first in the file", async () => {
    const first = await sharp({ create: { width: 600, height: 400, channels: 3, background: "#f00" } }).jpeg().toBuffer();
    const second = await sharp({ create: { width: 800, height: 200, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    const heic = withPrimary(await heicFrom(first, second), 2);
    const patched = join(folder, `${randomUUID()}.heic`);
    await writeFile(patched, heic);
    expect(heifImagesIn((await runFile("heif-info", [patched], { encoding: "utf8" })).stdout)).toEqual([
      { width: 600, height: 400, primary: false },
      { width: 800, height: 200, primary: true },
    ]);
    const mediaId = await uploadedPhoto(heic, "heic");

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 800, height: 200 });
    expect(await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes)).toEqual({ width: 480, height: 120, format: "webp" });
  });

  it.skipIf(!heicTests)(
    "refuses, without decoding anything, a HEIC whose small primary hides a second image past the pixel limit",
    async () => {
      const primary = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#f00" } }).jpeg().toBuffer();
      const hidden = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
      const heic = claimingSize(await heicFrom(primary, hidden), [160, 120], [15_000, 15_000]);
      // sharp sees only the primary, so its pixel limit can't catch this.
      expect(await sharp(heic).metadata()).toMatchObject({ width: 300, height: 200, pages: 2 });
      const mediaId = await uploadedPhoto(heic, "heic");

      expect(await permanentFailure(mediaId)).toBe("too-large");
      expect(runsOf("heif-info")).toHaveLength(1);
      expect(runsOf("heif-dec")).toEqual([]);
    },
  );

  it.skipIf(!heicTests)("refuses, without decoding anything, a HEIC whose images pass 210 megapixels together, though each is under", async () => {
    const first = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#f00" } }).jpeg().toBuffer();
    const second = await sharp({ create: { width: 160, height: 120, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    // Two images of 108 MP each: 216 MP for heif-dec to decode.
    const heic = claimingSize(claimingSize(await heicFrom(first, second), [300, 200], [12_000, 9_000]), [160, 120], [12_000, 9_000]);
    const mediaId = await uploadedPhoto(heic, "heic");

    expect(await permanentFailure(mediaId)).toBe("too-large");
    expect(runsOf("heif-dec")).toEqual([]);
  });

  it.skipIf(!heicTests)("refuses, without decoding anything, a HEIC holding more than 8 images", async () => {
    const images = await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        sharp({ create: { width: 64 + index * 8, height: 48, channels: 3, background: "#00f" } }).jpeg().toBuffer(),
      ),
    );
    const mediaId = await uploadedPhoto(await heicFrom(...images), "heic");

    expect(await permanentFailure(mediaId)).toBe("unsupported-type");
    expect(runsOf("heif-dec")).toEqual([]);
  });

  it.skipIf(!heicTests)("fails for good, not again and again, when heif-dec runs into its memory cap", async () => {
    const jpeg = await sharp(
      await sharp({
        create: { width: 600, height: 450, channels: 3, background: "#777", noise: { type: "gaussian", mean: 120, sigma: 40 } },
      })
        .png()
        .toBuffer(),
    )
      .resize(2400, 1800)
      .jpeg({ quality: 90 })
      .toBuffer();
    const mediaId = await uploadedPhoto(await heicFrom(jpeg), "heic");
    // 32 MiB: room for heif-dec to start and read the file, not to decode a 4 MP photo. Near its
    // cap heif-dec may exit or may wait forever; either way the file fails for good.
    const tinyCap = 32 * 1024 * 1024;

    const error = await permanentError(mediaId, { ...PHOTO_OPTIONS, heifMemoryBytes: tinyCap, heifDecodeMilliseconds: 5_000 });

    expect(error?.reason).toBe("corrupt");
    expect(error?.message).toMatch(/heif-dec .*(exited|killed \(timeout\))/);
    expect(runsOf("heif-dec")).toEqual([expect.arrayContaining(["prlimit", `--as=${tinyCap}`, "--", "heif-dec"])]);
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it.skipIf(!heicTests)("fails for good when heif-dec runs past its time, and publishes nothing", async () => {
    const mediaId = await uploadedPhoto(await heicFrom(await phonePhoto(1200, 900).jpeg().toBuffer()), "heic");

    const error = await permanentError(mediaId, { ...PHOTO_OPTIONS, heifDecodeMilliseconds: 1 });

    expect(error?.reason).toBe("corrupt");
    expect(error?.message).toMatch(/heif-dec .*killed \(timeout\)/);
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", listedAt: null });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it.skipIf(!heicTests)("makes a 12 MP HEIC ready well inside the 20 s budget on one sharp thread", async () => {
    const heic = await heicFrom(await twelveMegapixelPhoto());
    const mediaId = await uploadedPhoto(heic, "heic");

    const startedAt = performance.now();
    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);
    const milliseconds = performance.now() - startedAt;

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 4032, height: 3024 });
    expect((await readPublic(item.derived.thumb ?? "")).bytes.length).toBeLessThan(60 * 1024);
    expect(milliseconds).toBeLessThan(10_000);
  });
});

/** The PermanentJobError processPhoto failed with, or null when it didn't fail for good. */
async function permanentError(mediaId: string, options = PHOTO_OPTIONS): Promise<PermanentJobError | null> {
  try {
    await processPhoto(photoJob(mediaId), options);
    return null;
  } catch (error) {
    if (error instanceof PermanentJobError) return error;
    throw error;
  }
}

/** The reason processPhoto failed for good with, or a message saying it didn't. */
async function permanentFailure(mediaId: string, options = PHOTO_OPTIONS): Promise<string> {
  return (await permanentError(mediaId, options))?.reason ?? "no failure";
}

describe("a file that isn't a photo the album takes (Review Focus 5)", () => {
  const BOSS_SCHEMA = "pgboss_worker_photo_test";
  let boss: PgBoss;
  let workers: QueueWorkers | null = null;

  beforeAll(async () => {
    boss = await startTestBoss(BOSS_SCHEMA);
  });

  afterAll(async () => {
    workers?.stopFetching();
    await boss?.stop({ graceful: false });
    await dropBossSchema(BOSS_SCHEMA);
  });

  it("fails at once as corrupt when it is random bytes named .jpg, with no retries and nothing published", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    workers = await startQueueWorkers(
      boss,
      { [MEDIA_QUEUES.photo]: photoHandler(PHOTO_OPTIONS) },
      { photo: 1, jpeg: 1, poster: 1, wish: 1, visibility: 1, card: 1, convertOnDemand: 1, convertBacklog: 1 },
      { pollingIntervalSeconds: 0.5 },
    );
    const random = Buffer.concat([Buffer.from([0x13, 0x37, 0x00, 0x42]), randomBytes(20_000)]);
    const mediaId = await uploadedPhoto(random, "jpg");
    const jobId = await boss.send(MEDIA_QUEUES.photo, { mediaId });

    const deadline = Date.now() + 20_000;
    while ((await readItem(mediaId)).status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await readItem(mediaId)).toMatchObject({ status: "failed", failureReason: "corrupt", listedAt: null });
    const [job] = await boss.findJobs(MEDIA_QUEUES.photo, { id: jobId ?? "" });
    expect(job).toMatchObject({ state: "failed", retryCount: 0 });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it("fails as unsupported-type when it is a video, a PDF or an SVG named as a photo", async () => {
    const mp4Head = Buffer.alloc(24);
    mp4Head.writeUInt32BE(24, 0);
    mp4Head.write("ftypisomisomavc1", 4, "latin1");
    const files = {
      video: Buffer.concat([mp4Head, randomBytes(4096)]),
      pdf: Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n", "latin1"),
      svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "latin1"),
    };
    for (const [what, bytes] of Object.entries(files)) {
      const mediaId = await uploadedPhoto(bytes, "jpg");
      expect(await permanentFailure(mediaId), what).toBe("unsupported-type");
      expect(await publicKeysOf(mediaId), what).toEqual([]);
    }
  });

  it("fails as corrupt when a JPEG is cut short, or a HEIC holds nothing that decodes", async () => {
    const jpeg = await phonePhoto(1200, 900).jpeg().toBuffer();
    const cutShort = await uploadedPhoto(jpeg.subarray(0, Math.floor(jpeg.length / 2)), "jpg");
    const heicHead = Buffer.alloc(24);
    heicHead.writeUInt32BE(24, 0);
    heicHead.write("ftypheicmif1heic", 4, "latin1");
    const brokenHeic = await uploadedPhoto(Buffer.concat([heicHead, randomBytes(8192)]), "heic");

    expect(await permanentFailure(cutShort)).toBe("corrupt");
    expect(await permanentFailure(brokenHeic)).toBe("corrupt");
  });

  it("fails as too-large when a JPEG's header claims more than 210 megapixels, before decoding any", async () => {
    // A small JPEG whose frame header says 15,000 × 15,000: a decompression bomb.
    const bomb = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const frame = bomb.indexOf(Buffer.from([0xff, 0xc0]));
    bomb.writeUInt16BE(15_000, frame + 5);
    bomb.writeUInt16BE(15_000, frame + 7);
    const mediaId = await uploadedPhoto(bomb, "jpg");
    expect(await permanentFailure(mediaId)).toBe("too-large");
  });

  it("fails as too-large when another format's header claims more than 100 megapixels: only JPEG may have more", async () => {
    // A small PNG whose header (IHDR, with its checksum made again) says 12,000 × 9,000.
    const bomb = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#888" } }).png().toBuffer();
    const header = bomb.indexOf("IHDR", 0, "latin1");
    bomb.writeUInt32BE(12_000, header + 4);
    bomb.writeUInt32BE(9_000, header + 8);
    bomb.writeUInt32BE(crc32(bomb.subarray(header, header + 17)), header + 17);
    const mediaId = await uploadedPhoto(bomb, "png");
    expect(await permanentFailure(mediaId)).toBe("too-large");
  });
});

describe("the manifest, written again after the ready mark", () => {
  async function png(): Promise<Buffer> {
    return sharp({ create: { width: 320, height: 240, channels: 3, background: "#963" } }).png().toBuffer();
  }

  it("is tried again when R2 refuses it once or twice", async () => {
    const mediaId = await uploadedPhoto(await png(), "png", { capturedAt: new Date("2026-12-05T11:00:00Z") });
    manifests.failuresLeft = 2;

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    expect(manifests.failuresLeft).toBe(0);
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "ceremony" });
  });

  it("is given up after three tries, with the item ready and the failure said in the log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await uploadedPhoto(await png(), "png");
    manifests.failuresLeft = 99;

    const report = await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    expect(manifests.failuresLeft).toBe(96);
    expect(report).toMatchObject({ kind: "photo/png" });
    expect(await readItem(mediaId)).toMatchObject({ status: "ready" });
    expect(errors.mock.calls.flat().join(" ")).toContain(`media=${mediaId} is ready, but its manifest wasn't written`);
  });
});

describe("a job delivered twice, or for an item that has moved on (Ruling AG)", () => {
  async function png(): Promise<Buffer> {
    return sharp({ create: { width: 320, height: 240, channels: 3, background: "#369" } }).png().toBuffer();
  }

  it("does nothing, and succeeds, for an item no longer uploaded: ready, failed, still uploading, deleted or gone", async () => {
    const ready = await uploadedPhoto(await png(), "png", {
      status: "ready",
      listedAt: new Date("2026-12-05T12:00:00Z"),
      derived: { thumb: "derived/x/y/thumb.webp" },
      thumbhash: "kept",
    });
    const failed = await uploadedPhoto(await png(), "png", { status: "failed", failureReason: "corrupt" });
    const uploading = await uploadedPhoto(await png(), "png", { status: "uploading", uploadedAt: null });
    const deleted = await uploadedPhoto(await png(), "png", { deletedAt: new Date() });

    for (const mediaId of [ready, failed, uploading, deleted, randomUUID()]) {
      const before = await readItem(mediaId);
      await expect(processPhoto(photoJob(mediaId), PHOTO_OPTIONS)).resolves.toBeUndefined();
      expect(await readItem(mediaId), mediaId).toEqual(before);
      expect(await publicKeysOf(mediaId), mediaId).toEqual([]);
    }
  });

  it("publishes nothing for an item hidden, or removed by its uploader, before its turn: it waits, uploaded, for an unhide", async () => {
    const hidden = await uploadedPhoto(await png(), "png", { hiddenAt: new Date(), hiddenBy: "admin" });
    const removed = await uploadedPhoto(await png(), "png", { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true });

    for (const mediaId of [hidden, removed]) {
      await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);
      expect(await readItem(mediaId), mediaId).toMatchObject({ status: "uploaded", listedAt: null, thumbhash: null });
      expect(await publicKeysOf(mediaId), mediaId).toEqual([]);
    }
  });

  it("leaves alone an item another delivery finished while this one worked, and the files they share", async () => {
    const mediaId = await uploadedPhoto(await png(), "png");
    publishing.afterPut = async () => {
      await getDb()
        .update(media)
        .set({ status: "ready", listedAt: new Date("2026-12-05T12:00:00Z"), thumbhash: "the other delivery's" })
        .where(eq(media.id, mediaId));
    };

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", thumbhash: "the other delivery's" });
    expect(await publicKeysOf(mediaId)).toHaveLength(2);
  });

  it("removes what it published when the item is hidden while it works, and leaves it uploaded", async () => {
    const mediaId = await uploadedPhoto(await png(), "png");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await processPhoto(photoJob(mediaId), PHOTO_OPTIONS);

    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", listedAt: null, thumbhash: null });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });
});
