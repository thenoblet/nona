import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import exifr from "exifr";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../test/db";
import { workerConfig } from "../config";
import { PermanentJobError, type MediaJob } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { makeFullSizeJpeg, type JpegOptions } from "./jpeg";

/*
 * media.jpeg (Task 15): an iPhone photo's full-size JPEG, made on its first download, against the
 * local MinIO and test database. The HEIC tests need libheif's heif-enc and heif-dec, which the
 * worker image's test target has and requires.
 */

// A test can act between the JPEG going up and the row being marked.
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

// Every program the job runs, so a test can tell whether heif-dec ran, and under which cap.
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

const sentJobs = vi.hoisted(() => [] as { name: string; data: unknown }[]);

const JPEG_OPTIONS: JpegOptions = {
  heifMemoryBytes: workerConfig({}).heifMemoryBytes,
  heifThreads: workerConfig({}).threads.heif,
  jobQueue: async () =>
    ({
      send: async (name: string, data?: object | null) => {
        sentJobs.push({ name, data });
        return randomUUID();
      },
    }) as Pick<PgBoss, "send">,
};

const runFile = promisify(execFile);
async function hasProgram(name: string): Promise<boolean> {
  return runFile(name, ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
}
const heicTests =
  process.env.WORKER_TEST_IMAGE === "1" || ((await hasProgram("heif-enc")) && (await hasProgram("heif-dec")));

let folder: string;
const privateKeys: string[] = [];

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "nona-jpeg-test-"));
  await prepareScratchRoot(join(folder, "scratch"));
});

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
  if (privateKeys.length > 0) {
    await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: storageConfig().privateBucket,
        Delete: { Objects: privateKeys.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
  }
});

beforeEach(async () => {
  await resetDb();
  publishing.afterPut = null;
  programs.runs = [];
  sentJobs.length = 0;
});

async function publicKeysOf(mediaId: string): Promise<string[]> {
  const listing = await storageClient().send(new ListObjectsV2Command({ Bucket: storageConfig().publicBucket, Prefix: `derived/${mediaId}/` }));
  return (listing.Contents ?? []).map((object) => object.Key ?? "");
}

async function readPublic(key: string) {
  const response = await storageClient().send(new GetObjectCommand({ Bucket: storageConfig().publicBucket, Key: key }));
  return { bytes: Buffer.from((await response.Body?.transformToByteArray()) ?? []), contentType: response.ContentType, cacheControl: response.CacheControl };
}

/** A phone's landscape pixels with EXIF saying turn them a quarter (orientation 6), where (GPS) and when. */
function phonePhoto(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 60, b: 50 } } })
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 15" },
      IFD2: { DateTimeOriginal: "2026:12:05 19:42:07", OffsetTimeOriginal: "+00:00" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "6/1 50/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "1/1 59/1 0/1" },
    })
    .withMetadata({ orientation: 6 });
}

async function heicFrom(jpeg: Buffer): Promise<Buffer> {
  const name = randomUUID();
  const input = join(folder, `${name}.jpg`);
  const output = join(folder, `${name}.heic`);
  await writeFile(input, jpeg);
  await runFile("heif-enc", ["--quality", "60", "--output", output, input], { timeout: 120_000 });
  return readFile(output);
}

/** A ready iPhone photo in the album: its original in the private bucket, its row as the photo job leaves it. */
async function readyHeic(bytes: Uint8Array, values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
  const key = originalKey(id, "heic");
  privateKeys.push(key, `manifests/${id}.json`);
  await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: bytes }));
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "photo",
      guestId: null,
      uploaderName: "Akosua",
      celebration: "reception",
      originalKey: key,
      originalFilename: "IMG_0001.HEIC",
      sizeBytes: bytes.length,
      contentType: "image/heic",
      status: "ready",
      capturedAt: new Date("2026-12-05T19:42:07Z"),
      uploadedAt: new Date("2026-12-05T19:43:00Z"),
      listedAt: new Date("2026-12-05T19:43:02Z"),
      derived: { thumb: `derived/${id}/0123456789abcdef/thumb.webp`, view: `derived/${id}/0123456789abcdef/view.webp` },
      ...values,
    });
  return id;
}

function jpegJob(mediaId: string): MediaJob {
  return { id: randomUUID(), queue: MEDIA_QUEUES.jpeg, data: { mediaId }, signal: AbortSignal.timeout(120_000), retryCount: 0 };
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

describe.runIf(heicTests)("a HEIC's full-size JPEG", () => {
  it("is the HEIC at full size, upright, with no location but when it was taken, cached for good, and named derived.jpeg", async () => {
    const mediaId = await readyHeic(await heicFrom(await phonePhoto(1200, 800).jpeg({ quality: 90 }).toBuffer()));

    const report = await makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS);

    const item = await readItem(mediaId);
    expect(item.derived.jpeg).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/jpeg\\.jpg$`));
    expect(item.derived.thumb).toBeDefined();
    const jpeg = await readPublic(item.derived.jpeg as string);
    expect(jpeg.contentType).toBe("image/jpeg");
    expect(jpeg.cacheControl).toBe("public, max-age=31536000, immutable");
    // Turned upright by libheif as it decoded (the HEIF's own rotation), and never turned again.
    expect(await sharp(jpeg.bytes).metadata()).toMatchObject({ format: "jpeg", width: 800, height: 1200 });
    expect(await exifr.gps(jpeg.bytes).catch(() => undefined)).toBeUndefined();
    expect(jpeg.bytes.includes(Buffer.from("iPhone"))).toBe(false);
    expect(await exifr.parse(jpeg.bytes, { reviveValues: false })).toEqual({ DateTimeOriginal: "2026:12:05 19:42:07", OffsetTimeOriginal: "+00:00" });
    // heif-dec ran under the worker's memory cap.
    expect(programs.runs.find((run) => run.includes("heif-dec"))?.[1]).toBe(`--as=${JPEG_OPTIONS.heifMemoryBytes}`);
    expect(report).toEqual({ sizeBytes: expect.any(Number), kind: "photo/heic-jpeg" });
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "reception", hiddenAt: null });
  });

  it("Ruling BN: makes the JPEG of a HEIC of more tiles than sharp's own libheif takes, through heif-dec", async () => {
    const jpeg = await sharp({ create: { width: 320, height: 224, channels: 3, background: "#a07050", noise: { type: "gaussian", mean: 120, sigma: 30 } } })
      .jpeg({ quality: 80 })
      .toBuffer();
    const name = randomUUID();
    await writeFile(join(folder, `${name}.jpg`), jpeg);
    await runFile("heif-enc", ["--quality", "40", "--cut-tiles", "16", "--output", join(folder, `${name}.heic`), join(folder, `${name}.jpg`)], { timeout: 120_000 });
    const mediaId = await readyHeic(await readFile(join(folder, `${name}.heic`)));

    await makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS);

    const item = await readItem(mediaId);
    expect(await sharp((await readPublic(item.derived.jpeg as string)).bytes).metadata()).toMatchObject({ width: 320, height: 224 });
  });

  it("does nothing for a second delivery once the JPEG is made", async () => {
    const mediaId = await readyHeic(await heicFrom(await phonePhoto(300, 200).jpeg().toBuffer()));
    await makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS);
    const made = (await readItem(mediaId)).derived.jpeg;
    programs.runs = [];

    await expect(makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS)).resolves.toBeUndefined();
    expect(programs.runs).toEqual([]);
    expect((await readItem(mediaId)).derived.jpeg).toBe(made);
  });

  it("takes its JPEG down again when the photo is hidden while it works, and queues the withdrawal", async () => {
    const mediaId = await readyHeic(await heicFrom(await phonePhoto(300, 200).jpeg().toBuffer()));
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS);

    expect((await readItem(mediaId)).derived.jpeg).toBeUndefined();
    expect((await publicKeysOf(mediaId)).filter((key) => key.endsWith("/jpeg.jpg"))).toEqual([]);
    expect(sentJobs).toEqual([{ name: MEDIA_QUEUES.visibility, data: { mediaId, action: "hide" } }]);
  });
});

describe("media.jpeg's checks", () => {
  it("fails for good, as unsupported-type, an original that isn't a HEIC after all, leaving the photo ready", async () => {
    const jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#808080" } }).jpeg().toBuffer();
    const mediaId = await readyHeic(jpeg);

    const failure = await makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PermanentJobError);
    expect((failure as PermanentJobError).reason).toBe("unsupported-type");
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", failureReason: null });
    expect(programs.runs.filter((run) => run.includes("heif-dec"))).toEqual([]);
  });

  it("has nothing to do for a photo that is hidden, removed, not ready, not a HEIC, or a video", async () => {
    const bytes = Buffer.from("never read");
    const ids = [
      await readyHeic(bytes, { hiddenAt: new Date(), hiddenBy: "admin" }),
      await readyHeic(bytes, { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await readyHeic(bytes, { status: "uploaded", listedAt: null }),
      await readyHeic(bytes, { contentType: "image/jpeg" }),
      await readyHeic(bytes, { kind: "video", contentType: "video/quicktime" }),
      await readyHeic(bytes, { purpose: "wish" }),
      randomUUID(),
    ];
    for (const mediaId of ids) {
      await expect(makeFullSizeJpeg(jpegJob(mediaId), JPEG_OPTIONS), mediaId).resolves.toBeUndefined();
    }
    expect(programs.runs).toEqual([]);
  });
});
