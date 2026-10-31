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
 * (test/fixtures/iphone-hdr.mov), which is committed once it arrives (Ruling F). The worker image's
 * test target runs all of these; elsewhere the few that need ffmpeg 7 (or libheif's encoder) skip.
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

/** ffmpeg's major version here: 7 in the worker image (trixie), older on some machines. */
async function ffmpegMajorVersion(): Promise<number> {
  try {
    const { stdout } = await runFile("ffmpeg", ["-version"], { timeout: 10_000 });
    return Number(/ffmpeg version n?(\d+)\./.exec(stdout)?.[1] ?? 0);
  } catch {
    return 0;
  }
}

async function hasProgram(name: string): Promise<boolean> {
  return runFile(name, ["--version"], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
}

const inWorkerImage = process.env.WORKER_TEST_IMAGE === "1";
const ffmpegVersion = await ffmpegMajorVersion();
// The worker image's ffmpeg (7.1): its memory use and threads are what the cap was measured on.
const ffmpegSeven = inWorkerImage || ffmpegVersion >= 7;
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

/** Makes a clip with ffmpeg in the test's folder and returns its bytes. */
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
 * says to show it turned a quarter counter-clockwise (made by a copy pass with -display_rotation
 * 90): upright, it is portrait with the band down its left side. Its tags hold Apple's own
 * capture time, at +02:00.
 */
async function rotatedClip(): Promise<Buffer> {
  const flat = await clip("flat.mov", [
    ...["-f", "lavfi", "-i", "color=c=red:s=640x360:r=30,drawbox=x=0:y=0:w=640:h=90:color=blue:t=fill"],
    ...["-t", "2", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p"],
    ...["-tag:v", "hvc1", "-metadata", "com.apple.quicktime.creationdate=2026-12-06T01:00:00+0200"],
    ...["-movflags", "use_metadata_tags"],
  ]);
  const source = await saved(flat, "mov");
  // ffmpeg before 6 has no -display_rotation; its rotate tag writes the same display matrix.
  const rotation =
    ffmpegVersion >= 6 || inWorkerImage
      ? ["-display_rotation", "90", "-i", source, "-c", "copy"]
      : ["-i", source, "-c", "copy", "-metadata:s:v:0", "rotate=90"];
  const rotated = await clip("rotated.mov", [...rotation, "-movflags", "use_metadata_tags"]);
  const { stdout } = await runFile("ffprobe", [
    ...["-hide_banner", "-loglevel", "error", "-print_format", "json"],
    ...["-show_entries", "stream=width,height:stream_side_data_list", await saved(rotated, "mov")],
  ]);
  // ffprobe gives the display matrix's turn counter-clockwise: +90 here.
  expect(JSON.parse(stdout).streams[0].side_data_list).toEqual([expect.objectContaining({ rotation: 90 })]);
  return rotated;
}

/**
 * An iPhone-like HDR clip: a real HLG signal (ARIB STD-B67, BT.2020), 10-bit HEVC tagged as such,
 * made from an SDR test pattern by zscale. Shown without tone-mapping, it would be flat and grey.
 */
function hlgClip(size = "1280x720", seconds = 2, keyframeInterval = 60): Promise<Buffer> {
  return clip("hlg.mov", [
    ...["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-t", String(seconds)],
    ...["-vf", "zscale=tin=bt709:min=bt709:pin=bt709:rin=tv:t=arib-std-b67:m=bt2020nc:p=bt2020:r=tv:npl=100,format=yuv420p10le"],
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

function videoJob(mediaId: string): MediaJob {
  return {
    id: randomUUID(),
    queue: MEDIA_QUEUES.poster,
    data: { mediaId },
    signal: AbortSignal.timeout(180_000),
    retryCount: 0,
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

/** The image's mean luma, 0 to 255. */
async function meanLuma(bytes: Uint8Array): Promise<number> {
  const { channels } = await sharp(bytes).greyscale().stats();
  return channels[0].mean;
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

/** The error processVideo failed with, or null when it didn't fail. */
async function failureOf(mediaId: string, options = posterOptions()): Promise<Error | null> {
  try {
    await processVideo(videoJob(mediaId), options);
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The reason processVideo failed for good with, or a message saying it didn't. */
async function permanentFailure(mediaId: string, options = posterOptions()): Promise<string> {
  const error = await failureOf(mediaId, options);
  if (error === null) return "no failure";
  if (error instanceof PermanentJobError) return error.reason;
  return `retried: ${error.message}`;
}

/** Fails the test if the text holds a presigned link or any part of one. */
function expectNoLink(text: string): void {
  expect(text).not.toMatch(/X-Amz-|Signature|Credential|https?:\/\//);
}

describe("a video's poster (Review Focus 2)", () => {
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
      const luma = await meanLuma((await readPublic(item.derived["poster-view"] ?? "")).bytes);
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
    // An SDR clip isn't tone-mapped.
    expect(runsOf("ffmpeg").flat().join(" ")).not.toContain("tonemap");
    expect(report).toEqual({ sizeBytes: mp4.length, kind: "video/h264" });
  });

  it("is upright for a generated HEVC clip turned by its display matrix, and the video queues a backlog conversion", async () => {
    const mov = await rotatedClip();
    const mediaId = await uploadedVideo(mov, "mov");

    await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    // Stored upright: portrait.
    expect(item).toMatchObject({ status: "ready", width: 360, height: 640, videoCodec: "hevc", browserPlayable: false });
    const thumb = (await readPublic(item.derived["poster-thumb"] ?? "")).bytes;
    expect(await sizeOf(thumb)).toEqual({ width: 270, height: 480, format: "webp" });
    // Turned a quarter counter-clockwise, the band along the stored frame's top runs down the left.
    // Not along the top (not turned), not down the right (turned the wrong way), not along the bottom.
    expect(isBlue(await colourAt(thumb, 0.05, 0.5))).toBe(true);
    expect(isBlue(await colourAt(thumb, 0.95, 0.5))).toBe(false);
    expect(isBlue(await colourAt(thumb, 0.6, 0.03))).toBe(false);
    expect(isBlue(await colourAt(thumb, 0.6, 0.97))).toBe(false);
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
  });

  it("is tone-mapped to SDR for an HLG HDR clip, with its mean luma in SDR's range", async () => {
    const mov = await hlgClip();
    const mediaId = await uploadedVideo(mov, "mov");

    const report = await processVideo(videoJob(mediaId), posterOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", width: 1280, height: 720, videoCodec: "hevc", browserPlayable: false });
    const view = (await readPublic(item.derived["poster-view"] ?? "")).bytes;
    expect(await sizeOf(view)).toEqual({ width: 1280, height: 720, format: "webp" });
    const luma = await meanLuma(view);
    expect(luma).toBeGreaterThan(40);
    expect(luma).toBeLessThan(210);
    const filters = valueAfter(runsOf("ffmpeg")[0], "-vf") ?? "";
    expect(filters).toContain("zscale=tin=arib-std-b67");
    expect(filters).toContain("tonemap=tonemap=hable");
    expect(report).toMatchObject({ kind: "video/hevc-hdr" });
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

  it.skipIf(!ffmpegSeven)("makes a 4K HDR video's poster well inside the photo's 20 s budget, on one thread", async () => {
    // 4K HLG with keyframes 2 s apart: the poster's frame is decoded from the keyframe before it.
    const mov = await hlgClip("3840x2160", 1.6, 60);
    const mediaId = await uploadedVideo(mov, "mov");

    const startedAt = performance.now();
    await processVideo(videoJob(mediaId), posterOptions());
    const milliseconds = performance.now() - startedAt;

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", width: 3840, height: 2160 });
    expect(milliseconds).toBeLessThan(15_000);
  }, 180_000);

  it("reads the original over the presigned link, bounded, on the configured threads and under the memory cap", async () => {
    const options = posterOptions({ posterThreads: 2, filterThreads: 3 });
    const mediaId = await uploadedVideo(await androidClip(), "mp4");

    await processVideo(videoJob(mediaId), options);

    const [probe] = runsOf("ffprobe");
    const [poster] = runsOf("ffmpeg");
    for (const [tool, run] of [["ffprobe", probe], ["ffmpeg", poster]] as const) {
      expect(run.slice(0, 4), tool).toEqual(["prlimit", `--as=${options.ffmpegMemoryBytes}`, "--", tool]);
      // 10 s with nothing read or written, in microseconds.
      expect(valueAfter(run, "-rw_timeout"), tool).toBe("10000000");
      expect(valueAfter(run, "-format_whitelist"), tool).toBe("mov,matroska");
      expect(valueAfter(run, "-protocol_whitelist"), tool).toBe("http,https,tcp,tls");
    }
    // The link, never a download: ffprobe's last argument, ffmpeg's input.
    expect(probe.at(-1)).toMatch(/^http:\/\/localhost:9000\/nona-private\/originals\//);
    expect(valueAfter(poster, "-i")).toBe(probe.at(-1));
    expect(valueAfter(probe, "-probesize")).toBe("5000000");
    expect(valueAfter(probe, "-analyzeduration")).toBe("5000000");
    // -ss before -i: ffmpeg seeks with range requests rather than read up to the frame.
    expect(poster.indexOf("-ss")).toBeLessThan(poster.indexOf("-i"));
    expect(valueAfter(poster, "-ss")).toBe("1");
    expect(poster.slice(0, poster.indexOf("-i"))).toEqual(expect.arrayContaining(["-threads", "2"]));
    expect(valueAfter(poster, "-filter_threads")).toBe("3");
  });
});

describe("a file that isn't a video the album takes (Review Focus 5)", () => {
  let workers: QueueWorkers | null = null;

  afterAll(() => {
    workers?.stopFetching();
  });

  it("fails at once, as corrupt, when it was cut short, with no retries and nothing published", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    workers = await startQueueWorkers(
      boss,
      { [MEDIA_QUEUES.poster]: posterHandler(posterOptions()) },
      { photo: 1, jpeg: 1, poster: 1, wish: 1, visibility: 1, card: 1, convertOnDemand: 1, convertBacklog: 1 },
      { pollingIntervalSeconds: 0.5 },
    );
    // A phone writes the index (moov) last, so a recording cut short has none.
    const mp4 = await androidClip();
    const cut = await uploadedVideo(mp4.subarray(0, Math.floor(mp4.length / 2)), "mp4");
    const jobId = await boss.send(MEDIA_QUEUES.poster, { mediaId: cut });

    const deadline = Date.now() + 30_000;
    while ((await readItem(cut)).status !== "failed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(await readItem(cut)).toMatchObject({ status: "failed", failureReason: "corrupt", listedAt: null });
    const [job] = await boss.findJobs(MEDIA_QUEUES.poster, { id: jobId ?? "" });
    expect(job).toMatchObject({ state: "failed", retryCount: 0 });
    expect(await publicKeysOf(cut)).toEqual([]);
  });

  it("fails as corrupt when its index is whole but its frames are cut off, or it is random bytes", async () => {
    const faststart = await androidClip(3, true);
    const cutFrames = await uploadedVideo(faststart.subarray(0, 30_000), "mp4");
    const random = await uploadedVideo(Buffer.concat([Buffer.from([0x13, 0x37]), randomBytes(20_000)]), "mp4");

    expect(await permanentFailure(cutFrames)).toBe("corrupt");
    expect(await permanentFailure(random)).toBe("corrupt");
    expect(await publicKeysOf(cutFrames)).toEqual([]);
  });

  it("fails as unsupported-type when it is a photo, audio alone, or an MP3 named as a video", async () => {
    const files = {
      jpeg: await clip("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1"]),
      png: await clip("photo.png", ["-f", "lavfi", "-i", "testsrc2=size=64x48", "-frames:v", "1"]),
      m4a: await clip("voice.m4a", ["-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac"]),
      mp3: await clip("song.mp3", ["-f", "lavfi", "-i", "sine=duration=2"]),
    };
    for (const [what, bytes] of Object.entries(files)) {
      const mediaId = await uploadedVideo(bytes, "mp4");
      expect(await permanentFailure(mediaId), what).toBe("unsupported-type");
      expect(await publicKeysOf(mediaId), what).toEqual([]);
      expect(runsOf("ffmpeg"), what).toEqual([]);
    }
  });

  it.skipIf(!heicTests)("fails as unsupported-type when it is a HEIC photo, which ffmpeg 7 reads as a one-frame video", async () => {
    const jpeg = await saved(await clip("still.jpg", ["-f", "lavfi", "-i", "testsrc2=size=1200x900", "-frames:v", "1"]), "jpg");
    const heic = join(folder, `${randomUUID()}.heic`);
    await runFile("heif-enc", ["--quality", "60", "--output", heic, jpeg], { timeout: 120_000 });
    const mediaId = await uploadedVideo(await readFile(heic), "mov");

    expect(await permanentFailure(mediaId)).toBe("unsupported-type");
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it.skipIf(!ffmpegSeven)("fails for good, as corrupt, when ffmpeg runs into its memory cap on the file", async () => {
    // ffprobe and ffmpeg start within 400 MiB (their libraries need about 280), but a 720p HDR
    // poster needs about 600: so ffmpeg can't, and the file fails for good rather than retrying.
    const mediaId = await uploadedVideo(await hlgClip(), "mov");
    const cap = 400 * 1024 * 1024;

    const error = await failureOf(mediaId, posterOptions({ ffmpegMemoryBytes: cap }));

    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as PermanentJobError).reason).toBe("corrupt");
    expect(error?.message).toMatch(/^ffmpeg /);
    expect(runsOf("ffmpeg")).toEqual([expect.arrayContaining(["prlimit", `--as=${cap}`, "--", "ffmpeg"])]);
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
    const error = await failureOf(random);
    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error?.message).toContain("Invalid data found when processing input");
    expectNoLink(`${error?.message} ${JSON.stringify(error)} ${String(error?.stack)}`);
    expect(runsOf("ffprobe").flat().join(" ")).toContain("X-Amz-Signature=");

    // R2 out of reach: the link's port closed.
    publishing.link = (url) => url.replace(/:\/\/([^/:]+):\d+\//, "://$1:9/");
    const unreachable = await uploadedVideo(await androidClip(), "mp4");
    const networkError = await failureOf(unreachable);
    expect(networkError).not.toBeNull();
    expect(networkError).not.toBeInstanceOf(PermanentJobError);
    expect(networkError?.message).toMatch(/Connection refused/);
    expectNoLink(`${networkError?.message} ${JSON.stringify(networkError)} ${String(networkError?.stack)}`);
    expect(networkError?.cause).toBeUndefined();
    expect(await readItem(unreachable)).toMatchObject({ status: "uploaded" });

    expectNoLink(said.join("\n"));
  });
});

describe("videoToolFailure: the file's fault, for good, or the worker's or the network's, to try again", () => {
  const link = "https://account.r2.cloudflarestorage.com/nona-private/originals/x.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20261205%2Fauto%2Fs3%2Faws4_request&X-Amz-Signature=0123456789abcdef";
  const context = { memoryBytes: 2 * 1024 ** 3, link };
  const ended = (
    stderr: string,
    ending: ConstructorParameters<typeof ProcessError>[1] = "exit",
    exitCode: number | null = 1,
    exitSignal: NodeJS.Signals | null = null,
  ) => videoToolFailure("ffprobe", new ProcessError("prlimit", ending, exitCode, stderr, exitSignal), context);

  it("blames the file when ffprobe or ffmpeg can't read it, dies on it, or prints far too much", () => {
    const corrupt = [
      ended(`[mov,mp4,m4a,3gp,3g2,mj2 @ 0x55] moov atom not found\n${link}: Invalid data found when processing input\n`),
      ended("[hevc @ 0x55] Cannot allocate memory\n"),
      ended("[in#0/mov @ 0x55] pthread_create() failed: Resource temporarily unavailable\n", "exit", 245),
      ended("", "exit", null, "SIGSEGV"),
      ended("", "exit", null, "SIGABRT"),
      ended("", "too-much-output", null, "SIGKILL"),
    ];
    for (const error of corrupt) {
      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).reason).toBe("corrupt");
      expectNoLink(error.message);
    }
    expect(corrupt[0].message).toBe(
      "ffprobe couldn't read the video, under a 2147483648-byte cap: it exited with 1: the original: Invalid data found when processing input",
    );
  });

  it("calls a format ffmpeg recognised but the album doesn't take unsupported-type", () => {
    const error = ended(`[jpeg_pipe @ 0x57] Format not on whitelist 'mov,matroska'\n${link}: Invalid argument\n`);
    expect(error).toMatchObject({ reason: "unsupported-type" });
    expectNoLink(error.message);
  });

  it("tries again when R2 or the network failed it: refused, reset, timed out, an HTTP error, DNS or TLS", () => {
    const network = [
      `${link}: Server returned 404 Not Found`,
      `${link}: Server returned 5XX Server Error reply`,
      `${link}: Server returned 403 Forbidden (access denied)`,
      `[tcp @ 0x56] Connection to tcp://account.r2.cloudflarestorage.com:443 failed: Connection refused\n${link}: Connection refused`,
      `[tls @ 0x58] Error in the pull function.\n${link}: Input/output error`,
      `[tcp @ 0x60] Failed to resolve hostname account.r2.cloudflarestorage.com: Temporary failure in name resolution\n${link}: Input/output error`,
      `${link}: Connection timed out`,
      `[https @ 0x61] Stream ends prematurely at 1048576, should be 20000000\n${link}: Input/output error`,
      `${link}: Connection reset by peer`,
    ];
    for (const stderr of network) {
      const error = ended(stderr);
      expect(error, stderr).not.toBeInstanceOf(PermanentJobError);
      expectNoLink(error.message);
      expect(error.cause, stderr).toBeUndefined();
    }
  });

  it("tries again when the worker, not the file, ended it: a SIGKILL from outside, its time, its job, a stop, or a tool that couldn't run", () => {
    const spawnError = Object.assign(new Error("spawn prlimit ENOENT"), { code: "ENOENT", spawnargs: ["--", "ffprobe", link] });
    for (const error of [
      ended("", "exit", null, "SIGKILL"),
      ended("", "timeout", null, "SIGKILL"),
      ended("", "aborted", null, "SIGKILL"),
      ended("", "stopping", null, "SIGKILL"),
      ended("ffprobe: error while loading shared libraries: libFLAC.so.14: failed to map segment", "exit", 127),
      ended("", "exit", 126),
      videoToolFailure("ffprobe", spawnError, context),
    ]) {
      expect(error).not.toBeInstanceOf(PermanentJobError);
      expectNoLink(`${error.message} ${JSON.stringify(error)}`);
      expect(error.cause).toBeUndefined();
    }
  });
});

describe("a job delivered twice, or for an item that has moved on (Ruling AG)", () => {
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

describe("the poster's scratch", () => {
  it("is removed after the job, however it ends", async () => {
    const mediaId = await uploadedVideo(await androidClip(1), "mp4");
    await processVideo(videoJob(mediaId), posterOptions());
    const random = await uploadedVideo(randomBytes(4096), "mp4");
    await failureOf(random);

    expect(await readdir(join(folder, "scratch"))).toEqual([]);
  });
});
