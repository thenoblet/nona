import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { ProcessError } from "../processes";
import { PermanentJobError, startQueueWorkers, type MediaJob, type QueueWorkers } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { posterHandler, processVideo, videoToolFailure, type PosterOptions } from "./poster";

/*
 * media.poster against the local MinIO and test database (docker compose up -d db minio && npm run
 * storage:init). ffprobe and ffmpeg read the original over a presigned link, as in production.
 * Every clip is made here, in setup, by ffmpeg, except Noblet's own iPhone HEVC/HDR clip
 * (test/fixtures/iphone-hdr.mov), which is committed once it arrives (Ruling F).
 *
 * The job runs ffmpeg 7.1's options (the bounded reconnects are 7.0's), so the tests that run it run
 * where ffmpeg is 7 or later: always in the worker image's test target. The failure rules run anywhere.
 */

// A test can act between the poster's files going up and its row being marked (Ruling AG), or
// hand ffmpeg a link of its own in place of the presigned one.
const publishing = vi.hoisted(() => ({
  afterPut: null as null | (() => Promise<void>),
  link: null as null | ((url: string) => string),
}));
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
    presignGet: async (...args: Parameters<typeof real.presignGet>) => {
      const url = await real.presignGet(...args);
      return publishing.link ? publishing.link(url) : url;
    },
  };
});

// Every program the job runs, so a test can see its arguments.
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

const runFile = promisify(execFile);

/** `ffmpeg -version`'s first line, or "" when there is no ffmpeg. */
async function ffmpegVersionLine(): Promise<string> {
  try {
    const { stdout } = await runFile("ffmpeg", ["-version"], { timeout: 10_000 });
    return stdout.split("\n")[0];
  } catch {
    return "";
  }
}

async function hasProgram(name: string): Promise<boolean> {
  return runFile(name, ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
}

const inWorkerImage = process.env.WORKER_TEST_IMAGE === "1";
const versionLine = await ffmpegVersionLine();
// The job's options are ffmpeg 7's; elsewhere (an older ffmpeg) the tests that run it skip.
const ffmpegSeven = inWorkerImage || Number(/ffmpeg version n?(\d+)\./.exec(versionLine)?.[1] ?? 0) >= 7;
const heicTests = inWorkerImage || ((await hasProgram("heif-enc")) && (await hasProgram("heif-info")));
const IPHONE_HDR_SAMPLE = new URL("../../../test/fixtures/iphone-hdr.mov", import.meta.url);

const BOSS_SCHEMA = "pgboss_worker_poster_test";
let boss: PgBoss;
let folder: string;
let sharpThreads: number;
const privateKeys: string[] = [];

/** The production defaults: WORKER_FFMPEG_MEMORY_BYTES, WORKER_POSTER_THREADS and WORKER_FFMPEG_FILTER_THREADS. */
function posterOptions(changes: Partial<PosterOptions> = {}): PosterOptions {
  const config = workerConfig({});
  return {
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    posterThreads: config.threads.poster,
    filterThreads: config.threads.ffmpegFilters,
    jobQueue: async () => boss,
    ...changes,
  };
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "nona-poster-test-"));
  await prepareScratchRoot(join(folder, "scratch"));
  sharpThreads = sharp.concurrency();
  sharp.concurrency(1);
  boss = await startTestBoss(BOSS_SCHEMA);
});

afterAll(async () => {
  sharp.concurrency(sharpThreads);
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
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
  publishing.link = null;
  programs.runs = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The programs run since the test began whose arguments include `program`. */
function runsOf(program: string): string[][] {
  return programs.runs.filter((run) => run.includes(program));
}

/** Makes a clip (or a still) with ffmpeg in the test's folder and returns its bytes. */
async function clip(name: string, args: string[]): Promise<Buffer> {
  const output = join(folder, `${randomUUID()}-${name}`);
  await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, output], {
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return readFile(output);
}

/** Writes bytes to the test's folder, for ffmpeg or ffprobe to read. */
async function saved(bytes: Uint8Array, extension: string): Promise<string> {
  const path = join(folder, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes);
  return path;
}

/** An Android phone's clip: H.264 8-bit 4:2:0 and AAC in MP4, with its time and place in its tags. */
function androidClip(seconds = 3, faststart = false): Promise<Buffer> {
  return clip("android.mp4", [
    ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    ...["-metadata", "creation_time=2026-12-05T10:30:00Z", "-metadata", "location=+05.6037-000.1870/"],
    ...(faststart ? ["-movflags", "+faststart"] : []),
  ]);
}

/**
 * A landscape HEVC clip, 640 × 360 and red with a blue band along its top, whose display matrix
 * says to show it turned (made by a copy pass with -display_rotation): +90 is a quarter turn
 * counter-clockwise, so upright the band runs down the left; −90, an iPhone's portrait, clockwise,
 * so down the right. Its tags hold Apple's own capture time, at +02:00.
 */
async function rotatedClip(rotation: 90 | -90 = 90): Promise<Buffer> {
  const flat = await clip("flat.mov", [
    ...["-f", "lavfi", "-i", "color=c=red:s=640x360:r=30,drawbox=x=0:y=0:w=640:h=90:color=blue:t=fill"],
    ...["-t", "2", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"],
    ...["-tag:v", "hvc1", "-metadata", "com.apple.quicktime.creationdate=2026-12-06T01:00:00+0200"],
    ...["-movflags", "use_metadata_tags"],
  ]);
  const source = await saved(flat, "mov");
  const rotated = await clip("rotated.mov", [
    ...["-display_rotation", String(rotation), "-i", source, "-c", "copy", "-movflags", "use_metadata_tags"],
  ]);
  const { stdout } = await runFile("ffprobe", [
    ...["-hide_banner", "-loglevel", "error", "-print_format", "json"],
    ...["-show_entries", "stream=width,height:stream_side_data_list", await saved(rotated, "mov")],
  ]);
  // ffprobe gives the display matrix's turn counter-clockwise, as -display_rotation takes it.
  expect(JSON.parse(stdout).streams[0].side_data_list).toEqual([
    expect.objectContaining({ side_data_type: "Display Matrix", rotation }),
  ]);
  return rotated;
}

/** The test pattern every HDR clip is made from, at `size`. */
function testPattern(size: string): string {
  return `testsrc2=size=${size}:rate=30`;
}

/**
 * An iPhone-like HDR clip: the test pattern made into a real HLG signal (ARIB STD-B67, BT.2020) by
 * zscale (ffmpeg notes §5), as 10-bit HEVC tagged so. Shown without tone-mapping, it is flat and
 * dull: its colours read as BT.709 lose a third of their saturation.
 */
function hlgClip(size = "1280x720", seconds = 2, keyframeInterval = 60): Promise<Buffer> {
  return clip("hlg.mov", [
    ...["-f", "lavfi", "-i", testPattern(size), "-t", String(seconds)],
    ...[
      "-vf",
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=2020:t=arib-std-b67:m=2020_ncl:r=limited,format=yuv420p10le",
    ],
    ...["-c:v", "libx265", "-preset", "ultrafast"],
    ...[
      "-x265-params",
      `log-level=error:keyint=${keyframeInterval}:min-keyint=${keyframeInterval}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc`,
    ],
    ...["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"],
  ]);
}

/** Puts the bytes in the private bucket as a video's original, with its row `uploaded` as the upload API leaves it. */
async function uploadedVideo(
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
      kind: "video",
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "more",
      originalKey: key,
      originalFilename: `IMG_0001.${extension.toUpperCase()}`,
      sizeBytes: bytes.length,
      contentType: extension === "mov" ? "video/quicktime" : "video/mp4",
      status: "uploaded",
      startedAt: new Date("2026-12-07T12:00:00Z"),
      uploadedAt: new Date("2026-12-07T12:01:00Z"),
      ...values,
    });
  return id;
}

/** The job as pg-boss delivers it, on its first attempt unless `retryCount` says otherwise. */
function videoJob(mediaId: string, retryCount = 0): MediaJob {
  return {
    id: randomUUID(),
    queue: MEDIA_QUEUES.poster,
    data: { mediaId },
    signal: AbortSignal.timeout(180_000),
    retryCount,
  };
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

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

async function sizeOf(bytes: Uint8Array) {
  const { width, height, format } = await sharp(bytes).metadata();
  return { width, height, format };
}

/** The image's mean luma, 0 to 255, and mean saturation (HSV's), 0 to 1. */
async function lumaAndSaturation(bytes: Uint8Array): Promise<{ luma: number; saturation: number }> {
  const { data } = await sharp(bytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let luma = 0;
  let saturation = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    const [red, green, blue] = [data[offset], data[offset + 1], data[offset + 2]];
    const brightest = Math.max(red, green, blue);
    saturation += brightest === 0 ? 0 : (brightest - Math.min(red, green, blue)) / brightest;
    luma += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  const pixels = data.length / 3;
  return { luma: luma / pixels, saturation: saturation / pixels };
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
  return blue > 180 && red < 80 && green < 80;
}

/** The media.convert jobs sent for an item. */
async function conversionJobs(mediaId: string) {
  return boss.findJobs<{ mediaId: string }>(MEDIA_QUEUES.convert, { data: { mediaId } });
}

/** The value after `flag` in a program's arguments. */
function valueAfter(run: string[], flag: string): string | undefined {
  const at = run.indexOf(flag);
  return at === -1 ? undefined : run[at + 1];
}

/** The error processVideo failed with on attempt `retryCount + 1`, or null when it didn't fail. */
async function failureOf(mediaId: string, retryCount = 0, options = posterOptions()): Promise<Error | null> {
  try {
    await processVideo(videoJob(mediaId, retryCount), options);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The reason processVideo failed for good with on that attempt, "retried" when it may try again, or "no failure". */
async function outcomeOf(mediaId: string, retryCount = 0, options = posterOptions()): Promise<string> {
  const error = await failureOf(mediaId, retryCount, options);
  if (error === null) return "no failure";
  return error instanceof PermanentJobError ? error.reason : "retried";
}

/** Fails the test if the text holds a presigned link or any part of one. */
function expectNoLink(text: string): void {
  expect(text).not.toMatch(/X-Amz-|Signature|Credential|https?:\/\//i);
}

it.skipIf(!inWorkerImage)("runs on the worker image's ffmpeg 7.1, which the poster's options and memory cap were measured on", () => {
  expect(versionLine).toMatch(/^ffmpeg version 7\.1\./);
});

describe.skipIf(!ffmpegSeven)("a video's poster (Review Focus 2)", () => {
  it.skipIf(!existsSync(IPHONE_HDR_SAMPLE))(
    "Noblet's real iPhone HEVC/HDR clip (test/fixtures/iphone-hdr.mov, pending until it arrives) gives an upright SDR poster and is marked not playable",
    async () => {
      const sample = await readFile(IPHONE_HDR_SAMPLE);
      // ffprobe's own reading of its size and display matrix: the upright size is the shown one.
      const { stdout } = await runFile("ffprobe", [
        ...["-hide_banner", "-loglevel", "error", "-print_format", "json", "-select_streams", "v:0"],
        ...["-show_entries", "stream=width,height,color_transfer:stream_side_data_list", IPHONE_HDR_SAMPLE.pathname],
      ]);
      const [stream] = JSON.parse(stdout).streams;
      const rotation = stream.side_data_list?.find((data: { rotation?: number }) => data.rotation !== undefined)?.rotation ?? 0;
      const turned = Math.abs(rotation) % 180 === 90;
      const upright = turned ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
      expect(["arib-std-b67", "smpte2084"]).toContain(stream.color_transfer);
      const mediaId = await uploadedVideo(sample, "mov");

      const report = await processVideo(videoJob(mediaId), posterOptions());

      const item = await readItem(mediaId);
      expect(item).toMatchObject({ status: "ready", ...upright, videoCodec: "hevc", browserPlayable: false, conversion: "queued" });
      expect(item.capturedAt).toBeInstanceOf(Date);
      const thumb = (await readPublic(item.derived["poster-thumb"] ?? "")).bytes;
      const thumbSize = await sizeOf(thumb);
      expect(Math.max(thumbSize.width ?? 0, thumbSize.height ?? 0)).toBe(480);
      expect((thumbSize.width ?? 0) / (thumbSize.height ?? 1)).toBeCloseTo(upright.width / upright.height, 1);
      const { luma } = await lumaAndSaturation((await readPublic(item.derived["poster-view"] ?? "")).bytes);
      expect(luma).toBeGreaterThan(40);
      expect(luma).toBeLessThan(210);
      expect(runsOf("ffmpeg").flat().join(" ")).toContain("tonemap=tonemap=hable");
      expect(await conversionJobs(mediaId)).toEqual([expect.objectContaining({ priority: CONVERT_PRIORITY.backlog })]);
      expect(report).toMatchObject({ sizeBytes: sample.length, kind: "video/hevc-hdr" });
    },
  );

  it("is made from a generated H.264 clip, which every phone can play as it is: no conversion", async () => {
    const mp4 = await androidClip();
    const mediaId = await uploadedVideo(mp4, "mp4");

    const report = await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({
      status: "ready",
      failureReason: null,
      width: 640,
      height: 360,
      videoCodec: "h264",
      browserPlayable: true,
      conversion: "none",
      celebration: "ceremony",
    });
    expect(item.durationSeconds).toBeCloseTo(3, 1);
    expect(item.capturedAt?.toISOString()).toBe("2026-12-05T10:30:00.000Z");
    expect(item.listedAt).toBeInstanceOf(Date);
    expect(item.thumbhash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(item.averageColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(item.derived["poster-thumb"]).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/poster-thumb\\.webp$`));
    expect(item.derived["poster-view"]).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/poster-view\\.webp$`));
    expect((await publicKeysOf(mediaId)).sort()).toEqual([item.derived["poster-thumb"], item.derived["poster-view"]].sort());

    const thumb = await readPublic(item.derived["poster-thumb"] ?? "");
    const view = await readPublic(item.derived["poster-view"] ?? "");
    expect(await sizeOf(thumb.bytes)).toEqual({ width: 480, height: 270, format: "webp" });
    // Never enlarged past the video's own size.
    expect(await sizeOf(view.bytes)).toEqual({ width: 640, height: 360, format: "webp" });
    expect(thumb.contentType).toBe("image/webp");
    expect(thumb.cacheControl).toBe("public, max-age=31536000, immutable");
    for (const { bytes } of [thumb, view]) {
      const metadata = await sharp(bytes).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
    }
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "ceremony", celebrationSetByAdmin: false });
    expect(await conversionJobs(mediaId)).toEqual([]);
    // An SDR clip isn't tone-mapped, and its YUV is read as BT.709 (it is untagged), never BT.601.
    const filters = valueAfter(runsOf("ffmpeg")[0], "-vf") ?? "";
    expect(filters).not.toContain("tonemap");
    expect(filters).toContain(":in_color_matrix=bt709:in_range=tv,");
    expect(report).toEqual({ sizeBytes: mp4.length, kind: "video/h264" });
  });

  it("is upright for a generated HEVC clip turned by its display matrix either way, and the video queues a backlog conversion", async () => {
    // +90 turns it counter-clockwise, so the band along the stored frame's top runs down the left;
    // −90, an iPhone's portrait, clockwise, so down the right.
    for (const [rotation, bandAcross] of [
      [90, 0.05],
      [-90, 0.95],
    ] as const) {
      programs.runs = [];
      const mediaId = await uploadedVideo(await rotatedClip(rotation), "mov");

      await processVideo(videoJob(mediaId), posterOptions());

      const item = await readItem(mediaId);
      // Stored upright: portrait.
      expect(item, `${rotation}`).toMatchObject({
        status: "ready",
        width: 360,
        height: 640,
        videoCodec: "hevc",
        browserPlayable: false,
      });
      const thumb = (await readPublic(item.derived["poster-thumb"] ?? "")).bytes;
      expect(await sizeOf(thumb), `${rotation}`).toEqual({ width: 270, height: 480, format: "webp" });
      // On its side; not along the top (not turned), not on the other side (turned the wrong way), not along the bottom.
      expect(isBlue(await colourAt(thumb, bandAcross, 0.5)), `${rotation}`).toBe(true);
      expect(isBlue(await colourAt(thumb, 1 - bandAcross, 0.5)), `${rotation}`).toBe(false);
      expect(isBlue(await colourAt(thumb, 0.5, 0.03)), `${rotation}`).toBe(false);
      expect(isBlue(await colourAt(thumb, 0.5, 0.97)), `${rotation}`).toBe(false);
      // Apple's own date, at its offset: 01:00 on Sunday at +02:00 is 23:00 on Saturday in Accra.
      expect(item.capturedAt?.toISOString()).toBe("2026-12-05T23:00:00.000Z");
      expect(item.celebration).toBe("reception");
      expect(item.conversion).toBe("queued");
      expect(await conversionJobs(mediaId)).toEqual([
        expect.objectContaining({ state: "created", priority: CONVERT_PRIORITY.backlog, data: { mediaId } }),
      ]);
      // ffmpeg turns the frame itself, by the display matrix (its autorotate): no turn of our own on top.
      const [poster] = runsOf("ffmpeg");
      expect(poster).not.toContain("-noautorotate");
      expect(valueAfter(poster, "-vf")).not.toMatch(/transpose|rotate|hflip|vflip/);
    }
  });

  it("is tone-mapped to SDR for an HLG HDR clip: its colours as saturated as the SDR picture's, its luma in SDR's range", async () => {
    const mov = await hlgClip();
    // The test pattern as SDR, at the poster's moment (1 s, half the clip).
    const reference = await clip("reference.png", ["-f", "lavfi", "-i", testPattern("1280x720"), "-ss", "1", "-frames:v", "1"]);
    const mediaId = await uploadedVideo(mov, "mov");

    const report = await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 1280, height: 720, videoCodec: "hevc", browserPlayable: false });
    const view = (await readPublic(item.derived["poster-view"] ?? "")).bytes;
    expect(await sizeOf(view)).toEqual({ width: 1280, height: 720, format: "webp" });
    const poster = await lumaAndSaturation(view);
    const sdr = await lumaAndSaturation(reference);
    expect(poster.luma).toBeGreaterThan(40);
    expect(poster.luma).toBeLessThan(210);
    // Measured in the worker image: the SDR picture 0.97, tone-mapped 0.91, and the HLG read as if it
    // were BT.709 (no tone-mapping) 0.62. So the poster is within 0.12 of the SDR picture's.
    expect(Math.abs(poster.saturation - sdr.saturation)).toBeLessThan(0.12);
    const filters = valueAfter(runsOf("ffmpeg")[0], "-vf") ?? "";
    // zscale's own names for the colours (ffmpeg-filters, zscale).
    expect(filters).toContain("zscale=tin=arib-std-b67:min=2020_ncl:pin=2020:rin=limited:t=linear:npl=100");
    expect(filters).toContain("tonemap=tonemap=hable:desat=0,zscale=t=709:m=709:r=limited");
    expect(report).toMatchObject({ kind: "video/hevc-hdr" });
  });

  it("is made from an HDR clip whose fitted size would be odd: 2560 × 1080 fits 1600 × 675, which zscale refuses", async () => {
    const mediaId = await uploadedVideo(await hlgClip("2560x1080", 1.2), "mov");

    await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 2560, height: 1080 });
    expect(await sizeOf((await readPublic(item.derived["poster-view"] ?? "")).bytes)).toEqual({
      width: 1600,
      height: 676,
      format: "webp",
    });
    expect(valueAfter(runsOf("ffmpeg")[0], "-vf")).toContain(":force_original_aspect_ratio=decrease:force_divisible_by=2,");
  });

  it("is made from the very start of a clip of one frame, where seeking half its length finds nothing", async () => {
    const one = await clip("one.mp4", [
      ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "1"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p"],
    ]);
    const mediaId = await uploadedVideo(one, "mp4");

    await processVideo(videoJob(mediaId), posterOptions());

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", width: 1280, height: 720 });
    const posters = runsOf("ffmpeg");
    expect(posters.map((run) => valueAfter(run, "-ss"))).toEqual(["0.017", "0"]);
  });

  it("is made from the default (or largest) video stream of several, beside a data track: a Cinematic clip's disparity track is no second video", async () => {
    const twoVideos = await clip("two-videos.mov", [
      ...["-f", "lavfi", "-i", "color=c=green:s=160x90:r=30", "-f", "lavfi", "-i", testPattern("640x360")],
      ...["-t", "2", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
      ...["-disposition:v:0", "0", "-disposition:v:1", "default", "-timecode", "01:00:00:00"],
    ]);
    const { stdout } = await runFile("ffprobe", [
      ...["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_entries", "stream=index,codec_type,width"],
      await saved(twoVideos, "mov"),
    ]);
    const streams: { index: number; codec_type: string; width?: number }[] = JSON.parse(stdout).streams;
    expect(streams.slice(0, 2)).toEqual([
      expect.objectContaining({ index: 0, codec_type: "video", width: 160 }),
      expect.objectContaining({ index: 1, codec_type: "video", width: 640 }),
    ]);
    // A timecode (tmcd) data track for each video.
    expect(streams.slice(2).map((stream) => stream.codec_type)).toEqual(["data", "data"]);
    const mediaId = await uploadedVideo(twoVideos, "mov");

    await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 640, height: 360, videoCodec: "h264" });
    expect(valueAfter(runsOf("ffmpeg")[0], "-map")).toBe("0:1");
    expect(await sizeOf((await readPublic(item.derived["poster-thumb"] ?? "")).bytes)).toEqual({
      width: 480,
      height: 270,
      format: "webp",
    });
  });

  it("queues a backlog conversion for a playable video longer than about three minutes", async () => {
    const long = await clip("long.mp4", [
      ...["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=2", "-t", "185"],
      ...["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    ]);
    const mediaId = await uploadedVideo(long, "mp4");

    await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", browserPlayable: true, conversion: "queued" });
    expect(item.durationSeconds).toBeCloseTo(185, 0);
    expect(await conversionJobs(mediaId)).toHaveLength(1);
  });

  it("makes a 4K HDR video's poster well inside the photo's 20 s budget, on one thread", async () => {
    // 4K HLG with keyframes 2 s apart: the poster's frame is decoded from the keyframe before it.
    const mov = await hlgClip("3840x2160", 1.6, 60);
    const mediaId = await uploadedVideo(mov, "mov");

    const startedAt = performance.now();
    await processVideo(videoJob(mediaId), posterOptions());
    const milliseconds = performance.now() - startedAt;

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", width: 3840, height: 2160 });
    expect(milliseconds).toBeLessThan(15_000);
  }, 180_000);

  it("reads the original over the presigned link, bounded, with bounded reconnects, on the configured threads and under the memory cap", async () => {
    const options = posterOptions({ posterThreads: 2, filterThreads: 3 });
    const mediaId = await uploadedVideo(await androidClip(), "mp4");

    await processVideo(videoJob(mediaId), options);

    const [probe] = runsOf("ffprobe");
    const [poster] = runsOf("ffmpeg");
    for (const [tool, run] of [
      ["ffprobe", probe],
      ["ffmpeg", poster],
    ] as const) {
      expect(run.slice(0, 4), tool).toEqual(["prlimit", `--as=${options.ffmpegMemoryBytes}`, "--", tool]);
      // 10 s with nothing read or written, in microseconds.
      expect(valueAfter(run, "-rw_timeout"), tool).toBe("10000000");
      expect(valueAfter(run, "-format_whitelist"), tool).toBe("mov,matroska");
      // MinIO's plain http here; https,tls,tcp for R2.
      expect(valueAfter(run, "-protocol_whitelist"), tool).toBe("http,tcp");
      expect(valueAfter(run, "-reconnect"), tool).toBe("1");
      expect(valueAfter(run, "-reconnect_on_network_error"), tool).toBe("1");
      expect(valueAfter(run, "-reconnect_on_http_error"), tool).toBe("5xx");
      expect(valueAfter(run, "-reconnect_max_retries"), tool).toBe("2");
      expect(valueAfter(run, "-reconnect_delay_max"), tool).toBe("4");
    }
    // The link, never a download: ffprobe's last argument, ffmpeg's input.
    expect(probe.at(-1)).toMatch(/^http:\/\/localhost:9000\/nona-private\/originals\//);
    expect(probe).toContain("-show_error");
    expect(valueAfter(poster, "-i")).toBe(probe.at(-1));
    expect(poster).toEqual(expect.arrayContaining(["-xerror", "-nostats", "-y", "-nostdin"]));
    // -ss before -i: ffmpeg seeks with range requests rather than read up to the frame.
    expect(poster.indexOf("-ss")).toBeLessThan(poster.indexOf("-i"));
    expect(valueAfter(poster, "-ss")).toBe("1");
    expect(poster.slice(0, poster.indexOf("-i"))).toEqual(expect.arrayContaining(["-threads", "2"]));
    expect(valueAfter(poster, "-filter_threads")).toBe("3");
  });
});

describe.skipIf(!ffmpegSeven)("a file that isn't a video the album takes (Review Focus 5)", () => {
  let workers: QueueWorkers | null = null;

  afterAll(() => {
    workers?.stopFetching();
  });

  it("fails at once, through the queue, when it is a photo named as a video: no stall makes ffmpeg see a JPEG", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    workers = await startQueueWorkers(
      boss,
      { [MEDIA_QUEUES.poster]: posterHandler(posterOptions()) },
      { photo: 1, jpeg: 1, poster: 1, wish: 1, visibility: 1, card: 1, convertOnDemand: 1, convertBacklog: 1 },
      { pollingIntervalSeconds: 0.5 },
    );
    const jpeg = await clip("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1"]);
    const photo = await uploadedVideo(jpeg, "mp4");
    const photoJobId = await boss.send(MEDIA_QUEUES.poster, { mediaId: photo });
    // A phone writes the index (moov) last, so a recording cut short has none.
    const mp4 = await androidClip();
    const cut = await uploadedVideo(mp4.subarray(0, Math.floor(mp4.length / 2)), "mp4");
    const cutJobId = await boss.send(MEDIA_QUEUES.poster, { mediaId: cut });

    const deadline = Date.now() + 30_000;
    const settled = async () => {
      const [photoJob] = await boss.findJobs(MEDIA_QUEUES.poster, { id: photoJobId ?? "" });
      const [cutJob] = await boss.findJobs(MEDIA_QUEUES.poster, { id: cutJobId ?? "" });
      const failed = (await readItem(photo)).status === "failed";
      return photoJob?.state === "failed" && cutJob?.state === "retry" && failed;
    };
    while (!(await settled()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    workers.stopFetching();

    const [photoJob] = await boss.findJobs(MEDIA_QUEUES.poster, { id: photoJobId ?? "" });
    expect(photoJob).toMatchObject({ state: "failed", retryCount: 0 });
    // media.dead's handler marked it, with the reason its uploader sees.
    expect(await readItem(photo)).toMatchObject({ status: "failed", failureReason: "unsupported-type", listedAt: null });
    expect(await publicKeysOf(photo)).toEqual([]);
    // The file cut short waits to be tried again: on its first attempt it can't be told from a stalled read.
    const [cutJob] = await boss.findJobs(MEDIA_QUEUES.poster, { id: cutJobId ?? "" });
    expect(cutJob).toMatchObject({ state: "retry" });
    expect(await readItem(cut)).toMatchObject({ status: "uploaded", listedAt: null });
    expect(await publicKeysOf(cut)).toEqual([]);
  });

  it("is retried when it was cut short or is random bytes, and is corrupt for good on its third attempt", async () => {
    const mp4 = await androidClip();
    const files = {
      // The index (moov) last, as a phone writes it: none left.
      "index cut off": mp4.subarray(0, Math.floor(mp4.length / 2)),
      // The index first, its frames cut off before the poster's moment.
      "frames cut off": (await androidClip(3, true)).subarray(0, 30_000),
      "random bytes": Buffer.concat([Buffer.from([0x13, 0x37]), randomBytes(20_000)]),
    };
    for (const [what, bytes] of Object.entries(files)) {
      const mediaId = await uploadedVideo(bytes, "mp4");
      expect(await outcomeOf(mediaId, 0), what).toBe("retried");
      expect(await outcomeOf(mediaId, 1), what).toBe("retried");
      expect(await outcomeOf(mediaId, 2), what).toBe("corrupt");
      expect(await publicKeysOf(mediaId), what).toEqual([]);
      expect(await readItem(mediaId), what).toMatchObject({ status: "uploaded", listedAt: null });
    }
  });

  it("fails at once as unsupported-type when it is a photo, audio alone, or an MP3 named as a video", async () => {
    const files = {
      jpeg: await clip("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1"]),
      png: await clip("photo.png", ["-f", "lavfi", "-i", "testsrc2=size=64x48", "-frames:v", "1"]),
      m4a: await clip("voice.m4a", ["-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac"]),
      mp3: await clip("song.mp3", ["-f", "lavfi", "-i", "sine=duration=2"]),
    };
    for (const [what, bytes] of Object.entries(files)) {
      const mediaId = await uploadedVideo(bytes, "mp4");
      expect(await outcomeOf(mediaId, 0), what).toBe("unsupported-type");
      expect(await publicKeysOf(mediaId), what).toEqual([]);
      expect(runsOf("ffmpeg"), what).toEqual([]);
    }
  });

  it.skipIf(!heicTests)("fails at once as unsupported-type when it is a HEIC photo, which ffmpeg 7 reads as a one-frame video", async () => {
    const jpeg = await saved(await clip("still.jpg", ["-f", "lavfi", "-i", "testsrc2=size=1200x900", "-frames:v", "1"]), "jpg");
    const heic = join(folder, `${randomUUID()}.heic`);
    await runFile("heif-enc", ["--quality", "60", "--output", heic, jpeg], { timeout: 120_000 });
    const mediaId = await uploadedVideo(await readFile(heic), "mov");

    expect(await outcomeOf(mediaId, 0)).toBe("unsupported-type");
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it("runs ffmpeg under the memory cap, and a poster it can't make within it is tried again, never published", async () => {
    // ffprobe and ffmpeg start within 400 MiB (their libraries need about 280), but a 1080p HDR
    // poster needs more. Out of memory, ffmpeg fails as a damaged file would (corrupt from the third
    // attempt); short of a thread, it is the worker's trouble (retried). Either way not at once.
    const mediaId = await uploadedVideo(await hlgClip("1920x1080", 1.2), "mov");
    const cap = 400 * 1024 * 1024;

    const error = await failureOf(mediaId, 0, posterOptions({ ffmpegMemoryBytes: cap }));

    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(error?.message).toMatch(/^ffmpeg .*under a 419430400-byte cap/);
    expect(runsOf("ffmpeg")[0]).toEqual(expect.arrayContaining(["prlimit", `--as=${cap}`, "--", "ffmpeg"]));
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", listedAt: null });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it("never says the presigned link, in its errors or its logs, whatever ffprobe printed", async () => {
    const said: string[] = [];
    for (const stream of ["log", "error", "warn"] as const) {
      vi.spyOn(console, stream).mockImplementation((...parts: unknown[]) => {
        said.push(parts.map(String).join(" "));
      });
    }
    // ffprobe ends its error with the link it was given: "<link>: Invalid data found…".
    const random = await uploadedVideo(randomBytes(20_000), "mp4");
    for (const retryCount of [0, 2]) {
      const error = await failureOf(random, retryCount);
      expect(error?.message).toContain("the original: Invalid data found when processing input");
      expectNoLink(`${error?.message} ${JSON.stringify(error)} ${String(error?.stack)}`);
    }
    expect(runsOf("ffprobe").flat().join(" ")).toContain("X-Amz-Signature=");

    // R2 out of reach: the link's port closed.
    publishing.link = (url) => url.replace(/:\/\/([^/:]+):\d+\//, "://$1:9/");
    const unreachable = await uploadedVideo(await androidClip(1), "mp4");
    const networkError = await failureOf(unreachable, 2);
    expect(networkError).not.toBeNull();
    expect(networkError).not.toBeInstanceOf(PermanentJobError);
    expect(networkError?.message).toMatch(/couldn't read the original from R2: .*Connection refused/);
    expectNoLink(`${networkError?.message} ${JSON.stringify(networkError)} ${String(networkError?.stack)}`);
    expect(networkError?.cause).toBeUndefined();
    expect(await readItem(unreachable)).toMatchObject({ status: "uploaded" });

    expectNoLink(said.join("\n"));
  });
});

describe("videoToolFailure: the file's fault for good on the third attempt, the worker's or the network's to try again", () => {
  // What runProcess hands on: the link already replaced by "the original".
  const ended = (
    stderr: string,
    retryCount: number,
    ending: ConstructorParameters<typeof ProcessError>[1] = "exit",
    exitCode: number | null = 1,
    exitSignal: NodeJS.Signals | null = null,
  ) =>
    videoToolFailure("ffprobe", new ProcessError("prlimit", ending, exitCode, stderr, exitSignal), {
      memoryBytes: 2 * 1024 ** 3,
      retryCount,
    });
  const lookLikeTheFile: [string, ConstructorParameters<typeof ProcessError>[1], number | null, NodeJS.Signals | null][] = [
    ["[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55] moov atom not found\nthe original: Invalid data found when processing input\n", "exit", 1, null],
    ["[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55] error reading header\nthe original: End of file\n", "exit", 1, null],
    ["[vist#0:0/h264 @ 0x55] corrupt input packet in stream 0\n", "exit", 183, null],
    ["[vf#0:0 @ 0x58] Error while filtering: Cannot allocate memory\n", "exit", 244, null],
    ["", "exit", null, "SIGSEGV"],
    ["", "exit", null, "SIGABRT"],
    ["", "too-much-output", null, "SIGKILL"],
  ];

  it("tries again what looks like the file's fault on the first two attempts: over the network a stalled read looks the same", () => {
    for (const [stderr, ending, exitCode, exitSignal] of lookLikeTheFile) {
      for (const retryCount of [0, 1]) {
        const error = ended(stderr, retryCount, ending, exitCode, exitSignal);
        expect(error, `${stderr || exitSignal} on attempt ${retryCount + 1}`).not.toBeInstanceOf(PermanentJobError);
        expect(error.message).toMatch(/tried again: a stalled read from R2 looks the same/);
      }
    }
  });

  it("blames the file for it on the third attempt: corrupt, for good", () => {
    for (const [stderr, ending, exitCode, exitSignal] of lookLikeTheFile) {
      const error = ended(stderr, 2, ending, exitCode, exitSignal);
      expect(error, stderr || String(exitSignal)).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).reason).toBe("corrupt");
    }
    expect(ended(lookLikeTheFile[0][0], 2).message).toBe(
      "ffprobe couldn't read the video, under a 2147483648-byte cap: it exited with 1: the original: Invalid data found when processing input",
    );
  });

  it("calls a format ffmpeg recognised but the album doesn't take unsupported-type, at once", () => {
    const error = ended("[jpeg_pipe @ 0x57] Format not on whitelist 'mov,matroska'\nthe original: Invalid argument\n", 0);
    expect(error).toMatchObject({ reason: "unsupported-type" });
    expect(error.message).toContain("Format not on whitelist");
  });

  it("tries again, on every attempt, when R2 or the network failed it: refused, reset, timed out, an HTTP error, DNS or TLS", () => {
    const network = [
      "the original: Server returned 404 Not Found",
      "the original: Server returned 5XX Server Error reply",
      "the original: Server returned 403 Forbidden (access denied)",
      "[tcp @ 0x56] Connection to a link failed: Connection refused\nthe original: Connection refused",
      "[tls @ 0x58] Error in the pull function.\nthe original: Input/output error",
      "[tcp @ 0x60] Failed to resolve hostname the storage host: Temporary failure in name resolution\nthe original: Input/output error",
      "the original: Connection timed out",
      "[https @ 0x61] Stream ends prematurely at 1048576, should be 20000000\nthe original: Input/output error",
      "the original: Connection reset by peer",
    ];
    for (const stderr of network) {
      const error = ended(stderr, 2);
      expect(error, stderr).not.toBeInstanceOf(PermanentJobError);
      expect(error.message).toMatch(/couldn't read the original from R2/);
      expect(error.cause, stderr).toBeUndefined();
    }
  });

  it("tries again, on every attempt, when the worker, not the file, ended it: no thread, a SIGKILL from outside, its time, its job, a stop, or a tool that couldn't run", () => {
    const spawnError = Object.assign(new Error("spawn prlimit ENOENT"), { code: "ENOENT" });
    for (const error of [
      ended("[in#0/mov @ 0x55] pthread_create() failed: Resource temporarily unavailable\n", 2, "exit", 245),
      ended("[vf#0:0 @ 0x58] Task finished with error code: -11 (Resource temporarily unavailable)\n", 2, "exit", 245),
      ended("", 2, "exit", null, "SIGKILL"),
      ended("", 2, "timeout", null, "SIGKILL"),
      ended("", 2, "aborted", null, "SIGKILL"),
      ended("", 2, "stopping", null, "SIGKILL"),
      ended("ffprobe: error while loading shared libraries: libFLAC.so.14: failed to map segment", 2, "exit", 127),
      ended("", 2, "exit", 126),
      videoToolFailure("ffprobe", spawnError, { memoryBytes: 2 * 1024 ** 3, retryCount: 2 }),
    ]) {
      expect(error).not.toBeInstanceOf(PermanentJobError);
      expect(error.cause).toBeUndefined();
    }
  });
});

describe.skipIf(!ffmpegSeven)("a job delivered twice, or for an item that has moved on (Ruling AG)", () => {
  it("does nothing, and runs nothing, for an item no longer uploaded, or hidden, or gone", async () => {
    const mp4 = await androidClip(1);
    const ready = await uploadedVideo(mp4, "mp4", { status: "ready", listedAt: new Date(), thumbhash: "kept" });
    const failed = await uploadedVideo(mp4, "mp4", { status: "failed", failureReason: "corrupt" });
    const hidden = await uploadedVideo(mp4, "mp4", { hiddenAt: new Date(), hiddenBy: "admin" });
    const deleted = await uploadedVideo(mp4, "mp4", { deletedAt: new Date() });

    for (const mediaId of [ready, failed, hidden, deleted, randomUUID()]) {
      const before = await readItem(mediaId);
      await expect(processVideo(videoJob(mediaId), posterOptions())).resolves.toBeUndefined();
      expect(await readItem(mediaId), mediaId).toEqual(before);
      expect(await publicKeysOf(mediaId), mediaId).toEqual([]);
    }
    expect(programs.runs).toEqual([]);
  });

  it("sends one conversion however often the job is delivered", async () => {
    const mediaId = await uploadedVideo(await rotatedClip(), "mov");

    await processVideo(videoJob(mediaId), posterOptions());
    await processVideo(videoJob(mediaId), posterOptions());

    expect(await conversionJobs(mediaId)).toHaveLength(1);
  });

  it("leaves alone an item another delivery finished while this one worked, and sends no conversion of its own", async () => {
    const mediaId = await uploadedVideo(await rotatedClip(), "mov");
    publishing.afterPut = async () => {
      await getDb()
        .update(media)
        .set({ status: "ready", listedAt: new Date("2026-12-05T12:00:00Z"), thumbhash: "the other delivery's" })
        .where(eq(media.id, mediaId));
    };

    await processVideo(videoJob(mediaId), posterOptions());

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", thumbhash: "the other delivery's", conversion: "none" });
    expect(await publicKeysOf(mediaId)).toHaveLength(2);
    expect(await conversionJobs(mediaId)).toEqual([]);
  });

  it("removes what it published when the item is hidden while it works, and leaves it uploaded", async () => {
    const mediaId = await uploadedVideo(await rotatedClip(), "mov");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await processVideo(videoJob(mediaId), posterOptions());

    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", listedAt: null, thumbhash: null, conversion: "none" });
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(await conversionJobs(mediaId)).toEqual([]);
  });

  it("is ready though its conversion couldn't be sent: the sweeper sends it from the row's queued state", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await uploadedVideo(await rotatedClip(), "mov");
    const unreachableQueue = async () => {
      throw new Error("The job queue is down");
    };

    const report = await processVideo(videoJob(mediaId), posterOptions({ jobQueue: unreachableQueue }));

    expect(report).toMatchObject({ kind: "video/hevc" });
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", conversion: "queued" });
    expect(errors.mock.calls.flat().join(" ")).toContain(`media=${mediaId} is ready, but its conversion wasn't sent`);
  });
});

describe.skipIf(!ffmpegSeven)("the poster's scratch", () => {
  it("is removed after the job, however it ends", async () => {
    const mediaId = await uploadedVideo(await androidClip(1), "mp4");
    await processVideo(videoJob(mediaId), posterOptions());
    const random = await uploadedVideo(randomBytes(4096), "mp4");
    await failureOf(random);

    expect(await readdir(join(folder, "scratch"))).toEqual([]);
  });
});
