import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
import { PermanentJobError, startQueueWorkers, type MediaJob, type QueueWorkers } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { processPhoto } from "./photo";

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

    const report = await processPhoto(photoJob(mediaId));

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

    await processPhoto(photoJob(mediaId));

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

    const report = await processPhoto(photoJob(mediaId));

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

      const report = await processPhoto(photoJob(mediaId));

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

    await processPhoto(photoJob(mediaId));

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
    await processPhoto(photoJob(mediaId));
    const milliseconds = performance.now() - startedAt;

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 4032, height: 3024 });
    const thumb = (await readPublic(item.derived.thumb ?? "")).bytes;
    expect(thumb.length).toBeLessThan(60 * 1024);
    expect(milliseconds).toBeLessThan(10_000);
  });
});

describe("a photo's capture time and celebration", () => {
  it("are read from the EXIF, with its offset, and the celebration assigned again from that time", async () => {
    // 01:00 on Sunday at +02:00 is 23:00 on Saturday in Accra: the reception, not the thanksgiving.
    const mediaId = await uploadedPhoto(await phonePhoto(1200, 900).jpeg().toBuffer(), "jpg", { celebration: "more" });

    await processPhoto(photoJob(mediaId));

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

    await processPhoto(photoJob(mediaId));

    const item = await readItem(mediaId);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T10:30:00.000Z");
    expect(item.celebration).toBe("ceremony");
  });

  it("keep the celebration the couple moved the item to", async () => {
    const mediaId = await uploadedPhoto(await phonePhoto(1200, 900).jpeg().toBuffer(), "jpg", {
      celebration: "thanks",
      celebrationSetByAdmin: true,
    });

    await processPhoto(photoJob(mediaId));

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", celebration: "thanks", celebrationSetByAdmin: true });
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
  });

  it("fall back to the time the phone sent when the file has none", async () => {
    const png = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#654" } }).png().toBuffer();
    const mediaId = await uploadedPhoto(png, "png", { capturedAt: new Date("2026-12-05T11:00:00Z") });

    await processPhoto(photoJob(mediaId));

    const item = await readItem(mediaId);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T11:00:00.000Z");
    expect(item.celebration).toBe("ceremony");
  });

  it("leave an item listed before in its place in the album", async () => {
    const listedAt = new Date("2026-12-05T12:00:00Z");
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123" } }).png().toBuffer();
    const mediaId = await uploadedPhoto(png, "png", { listedAt });

    await processPhoto(photoJob(mediaId));

    expect((await readItem(mediaId)).listedAt?.toISOString()).toBe(listedAt.toISOString());
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

      const report = await processPhoto(photoJob(mediaId));

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

    const report = await processPhoto(photoJob(mediaId));

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
  });

  it.skipIf(!heicTests)("takes the primary image of a HEIC that holds several", async () => {
    const heic = await heicFrom(
      await phonePhoto(1200, 900).jpeg({ quality: 90 }).toBuffer(),
      await sharp({ create: { width: 800, height: 200, channels: 3, background: "#0f0" } }).jpeg().toBuffer(),
    );
    const mediaId = await uploadedPhoto(heic, "heic");

    await processPhoto(photoJob(mediaId));

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 900, height: 1200 });
    expect(await sizeOf((await readPublic(item.derived.thumb ?? "")).bytes)).toEqual({ width: 360, height: 480, format: "webp" });
  });

  it.skipIf(!heicTests)("makes a 12 MP HEIC ready well inside the 20 s budget on one sharp thread", async () => {
    const heic = await heicFrom(await twelveMegapixelPhoto());
    const mediaId = await uploadedPhoto(heic, "heic");

    const startedAt = performance.now();
    await processPhoto(photoJob(mediaId));
    const milliseconds = performance.now() - startedAt;

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 4032, height: 3024 });
    expect((await readPublic(item.derived.thumb ?? "")).bytes.length).toBeLessThan(60 * 1024);
    expect(milliseconds).toBeLessThan(10_000);
  });
});

/** The reason processPhoto failed for good with, or a message saying it didn't. */
async function permanentFailure(mediaId: string): Promise<string> {
  try {
    await processPhoto(photoJob(mediaId));
    return "no failure";
  } catch (error) {
    return error instanceof PermanentJobError ? error.reason : `not permanent: ${String(error)}`;
  }
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
      { [MEDIA_QUEUES.photo]: processPhoto },
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

  it("fails as too-large when its header claims more than 100 megapixels, before decoding any", async () => {
    // A small JPEG whose frame header says 12,000 × 9,000: a decompression bomb.
    const bomb = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const frame = bomb.indexOf(Buffer.from([0xff, 0xc0]));
    bomb.writeUInt16BE(9_000, frame + 5);
    bomb.writeUInt16BE(12_000, frame + 7);
    const mediaId = await uploadedPhoto(bomb, "jpg");
    expect(await permanentFailure(mediaId)).toBe("too-large");
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
      await expect(processPhoto(photoJob(mediaId))).resolves.toBeUndefined();
      expect(await readItem(mediaId), mediaId).toEqual(before);
      expect(await publicKeysOf(mediaId), mediaId).toEqual([]);
    }
  });

  it("publishes nothing for an item hidden, or removed by its uploader, before its turn: it waits, uploaded, for an unhide", async () => {
    const hidden = await uploadedPhoto(await png(), "png", { hiddenAt: new Date(), hiddenBy: "admin" });
    const removed = await uploadedPhoto(await png(), "png", { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true });

    for (const mediaId of [hidden, removed]) {
      await processPhoto(photoJob(mediaId));
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

    await processPhoto(photoJob(mediaId));

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", thumbhash: "the other delivery's" });
    expect(await publicKeysOf(mediaId)).toHaveLength(2);
  });

  it("removes what it published when the item is hidden while it works, and leaves it uploaded", async () => {
    const mediaId = await uploadedPhoto(await png(), "png");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await processPhoto(photoJob(mediaId));

    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", listedAt: null, thumbhash: null });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });
});
