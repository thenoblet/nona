import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { CONVERT_PRIORITY, MEDIA_QUEUE_OPTIONS, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { headOriginal } from "@/lib/storage/objects";
import { readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { PermanentJobError, startQueueWorkers, type MediaJob, type QueueWorkers } from "../queues";
import { prepareScratchRoot } from "../scratch";
import {
  conversionCpuSeconds,
  conversionMilliseconds,
  conversionThreads,
  convertHandler,
  convertVideo,
  outputProblem,
  type ConvertOptions,
} from "./convert";
import { photoHandler } from "./photo";
import { contentHashOf } from "./publishing";
import { runVideoTool } from "./video-tools";

/*
 * media.convert against the local MinIO and test database (docker compose up -d db minio && npm run
 * storage:init). Every clip is made here by ffmpeg (Ruling F); Noblet's own iPhone clip
 * (test/fixtures/iphone-hdr.mov) is still to come, and its test is the poster's.
 *
 * The conversion runs ffmpeg 7.1's filters and options (the HDR side data it deletes are 7's), so
 * the tests that run it run where ffmpeg is 7 or later: always in the worker image's test target.
 * The output checks and the time limit run anywhere.
 */

// A test can act between the converted file going up and its row being marked (Ruling AG).
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

// Every program the job runs, with its priority, so a test can see how it ran.
type ProgramRun = { args: string[]; priority: string };
const programs = vi.hoisted(() => ({ runs: [] as ProgramRun[] }));
vi.mock("../processes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../processes")>();
  return {
    ...real,
    runProcess: (...args: Parameters<typeof real.runProcess>) => {
      programs.runs.push({ args: [args[0], ...args[1]], priority: args[2].priority });
      return real.runProcess(...args);
    },
  };
});

// The free space each job asked its scratch folder for.
const scratch = vi.hoisted(() => ({ bytesNeeded: [] as number[] }));
vi.mock("../scratch", async (importOriginal) => {
  const real = await importOriginal<typeof import("../scratch")>();
  const withScratch: typeof real.withScratch = (bytesNeeded, task) => {
    scratch.bytesNeeded.push(bytesNeeded);
    return real.withScratch(bytesNeeded, task);
  };
  return { ...real, withScratch };
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

const inWorkerImage = process.env.WORKER_TEST_IMAGE === "1";
const versionLine = await ffmpegVersionLine();
// The conversion's filters and options are ffmpeg 7's; elsewhere (an older ffmpeg) the tests that run it skip.
const ffmpegSeven = inWorkerImage || Number(/ffmpeg version n?(\d+)\./.exec(versionLine)?.[1] ?? 0) >= 7;

const BOSS_SCHEMA = "pgboss_worker_convert_test";
const CAPTURED_AT = new Date("2026-12-05T23:00:00Z");
/** A location every GPS fixture carries: the venue, in Accra. */
const LOCATION = "+05.6037-000.1870+061.000/";
let boss: PgBoss;
let folder: string;
let scratchRoot: string;
let sharpThreads: number;
let workers: QueueWorkers | null = null;
const privateKeys: string[] = [];

/** The production defaults: the conversion's memory cap, threads and preset. */
function convertOptions(changes: Partial<ConvertOptions> = {}): ConvertOptions {
  const config = workerConfig({});
  return {
    convertMemoryBytes: config.convertMemoryBytes,
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    decoderThreads: config.threads.decoder,
    x264Threads: config.threads.x264,
    filterThreads: config.threads.ffmpegFilters,
    cpus: config.cpus,
    x264Preset: config.x264Preset,
    x264Cap: config.x264Cap,
    convertMaxSeconds: config.convertMaxSeconds,
    jobQueue: async () => boss,
    ...changes,
  };
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "nona-convert-test-"));
  scratchRoot = join(folder, "scratch");
  await prepareScratchRoot(scratchRoot);
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
  programs.runs = [];
  scratch.bytesNeeded = [];
});

afterEach(async () => {
  if (workers) {
    workers.stopFetching();
    workers = null;
    // Let the stopped workers' loops end.
    await new Promise((resolve) => setTimeout(resolve, 600));
  }
  // No test's jobs (a held copy, a dead letter) are left for the next test's workers.
  for (const queue of Object.values(MEDIA_QUEUES)) await boss.deleteAllJobs(queue);
  vi.restoreAllMocks();
});

/** The ffmpeg conversions run since the test began (not ffprobe, not the fixtures' ffmpeg). */
function conversionRuns(): ProgramRun[] {
  return programs.runs.filter((run) => run.args.includes("ffmpeg"));
}

/** Makes a clip with ffmpeg in the test's folder and returns its bytes. */
async function clip(name: string, args: string[]): Promise<Buffer> {
  const output = join(folder, `${randomUUID()}-${name}`);
  await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, output], {
    timeout: 600_000,
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

/** The HLG signal of ffmpeg notes §5: a test pattern made ARIB STD-B67 / BT.2020 by zscale, tagged so. */
const HLG_FILTERS =
  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=2020:t=arib-std-b67:m=2020_ncl:r=limited,format=yuv420p10le";
const HLG_TAGS = ["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"];

/**
 * 10-bit HEVC HLG of `size`, with mono AAC: an iPhone's picture and sound, before its display
 * matrix and tags. With `grain`, it has a camera sensor's noise at an iPhone's 4K bitrate (about 45
 * Mbit/s), which takes as long to decode and encode as real footage; a clean test pattern takes a
 * fraction of that.
 */
function hlgClip(size: string, seconds: number, { grain = false } = {}): Promise<Buffer> {
  const rate = 30;
  return clip("hlg.mov", [
    ...["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${rate}`],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-t", String(seconds), "-vf", grain ? `noise=alls=12:allf=t+u,${HLG_FILTERS}` : HLG_FILTERS],
    ...["-c:v", "libx265", "-preset", "ultrafast"],
    ...[
      "-x265-params",
      `log-level=error:keyint=${rate}:min-keyint=${rate}:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc${grain ? ":bitrate=45000" : ""}`,
    ],
    ...HLG_TAGS,
    ...["-c:a", "aac", "-ac", "1"],
  ]);
}

/**
 * An iPhone's portrait HDR clip: HLG 1920 × 1080 stored, shown turned −90 (upright 1080 × 1920),
 * with Apple's location key, its own capture time and a location tag, as an iPhone's MOV carries.
 */
async function iphoneClip(): Promise<Buffer> {
  const flat = await saved(await hlgClip("1920x1080", 2), "mov");
  return clip("iphone.mov", [
    ...["-display_rotation", "-90", "-i", flat, "-c", "copy", "-map_metadata", "-1"],
    ...["-movflags", "use_metadata_tags"],
    ...["-metadata", `com.apple.quicktime.location.ISO6709=${LOCATION}`],
    ...["-metadata", "com.apple.quicktime.creationdate=2026-12-06T01:00:00+0200"],
    ...["-metadata", "com.apple.quicktime.make=Apple", "-metadata", "com.apple.quicktime.model=iPhone 15 Pro"],
    ...["-metadata", "com.apple.quicktime.software=17.1.2"],
    ...["-metadata", `location=${LOCATION}`],
    ...["-f", "mov"],
  ]);
}

/** Apple's keys of the phone that made a clip, which a conversion must not carry. */
const PHONE_KEYS = /quicktime\.(make|model|software)|iPhone 15 Pro|17\.1\.2/;

/**
 * An Android phone's clip: H.264 at full range (yuvj420p), with AAC, in a MOV whose location is a
 * `©xyz` atom, and its creation time.
 */
function androidClip(): Promise<Buffer> {
  return clip("android.mov", [
    ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"],
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuvj420p", "-color_range", "pc", "-c:a", "aac"],
    ...["-metadata", `location=${LOCATION}`, "-metadata", "creation_time=2026-12-05T10:30:00Z", "-f", "mov"],
  ]);
}

/** 1080p at 60 fps, H.264 with no audio, in an MP4 whose location is a `loci` atom. */
function sixtyFramesClip(): Promise<Buffer> {
  return clip("sixty.mp4", [
    ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60"],
    ...["-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"],
    ...["-metadata", `location=${LOCATION}`, "-f", "mp4"],
  ]);
}

/** HDR10: PQ with a mastering display and content light levels, which libx264 would carry into SDR (ffmpeg notes §4.6). */
function pqClip(): Promise<Buffer> {
  return clip("pq.mov", [
    ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "1"],
    ...["-vf", HLG_FILTERS.replace("t=arib-std-b67", "t=smpte2084")],
    ...["-c:v", "libx265", "-preset", "ultrafast"],
    ...[
      "-x265-params",
      "log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400",
    ],
    ...["-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-tag:v", "hvc1"],
  ]);
}

/** A phone's faststart MP4 cut to half its bytes: ffprobe still reads all of its index, but half its frames are gone (ffmpeg notes §5). */
async function truncatedClip(): Promise<Buffer> {
  const whole = await clip("whole.mp4", [
    ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440"],
    ...["-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"],
    ...["-movflags", "+faststart"],
  ]);
  return whole.subarray(0, Math.floor(whole.length / 2));
}

/**
 * Puts the bytes in the private bucket as a video's original, with its row as the poster job
 * leaves an unplayable one: ready, listed, its poster's files named, its conversion queued.
 */
async function readyVideo(bytes: Uint8Array, extension: string, values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
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
      celebration: "reception",
      originalKey: key,
      originalFilename: `IMG_0001.${extension.toUpperCase()}`,
      sizeBytes: bytes.length,
      contentType: extension === "mov" ? "video/quicktime" : "video/mp4",
      status: "ready",
      startedAt: new Date("2026-12-06T12:00:00Z"),
      uploadedAt: new Date("2026-12-06T12:01:00Z"),
      listedAt: new Date("2026-12-06T12:02:00Z"),
      capturedAt: CAPTURED_AT,
      derived: { "poster-thumb": `derived/${id}/0000000000000000/poster-thumb.webp`, "poster-view": `derived/${id}/0000000000000000/poster-view.webp` },
      width: 1080,
      height: 1920,
      videoCodec: "hevc",
      browserPlayable: false,
      conversion: "queued",
      ...values,
    });
  return id;
}

/** Puts a JPEG in the private bucket as a photo's original, with its row `uploaded` as the upload API leaves it. */
async function uploadedPhoto(bytes: Uint8Array): Promise<string> {
  const id = randomUUID();
  const key = originalKey(id, "jpg");
  privateKeys.push(key, `manifests/${id}.json`);
  await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: bytes }));
  await getDb().insert(media).values({
    id,
    purpose: "album",
    kind: "photo",
    guestId: null,
    uploaderName: "Kofi Mensah",
    celebration: "more",
    originalKey: key,
    originalFilename: "IMG_0002.JPG",
    sizeBytes: bytes.length,
    contentType: "image/jpeg",
    status: "uploaded",
    startedAt: new Date("2026-12-06T12:00:00Z"),
    uploadedAt: new Date("2026-12-06T12:01:00Z"),
  });
  return id;
}

/**
 * The job as pg-boss delivers it, on its first attempt unless `retryCount` says otherwise. pg-boss
 * keeps a job's id across its attempts, and the id is the conversion's lease: pass the same `id` for
 * the attempts of one job.
 */
function convertJob(
  mediaId: string,
  retryCount = 0,
  { signal = AbortSignal.timeout(600_000), id = randomUUID() }: { signal?: AbortSignal; id?: string } = {},
): MediaJob {
  return { id, queue: MEDIA_QUEUES.convert, data: { mediaId }, signal, retryCount };
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

/** The error convertVideo failed with on attempt `retryCount + 1` of job `id`, or null when it didn't fail. */
async function failureOf(mediaId: string, retryCount = 0, options = convertOptions(), id = randomUUID()): Promise<Error | null> {
  try {
    await convertVideo(convertJob(mediaId, retryCount, { id }), options);
    return null;
  } catch (error) {
    return error as Error;
  }
}

type Stream = Record<string, unknown> & { codec_type: string; tags?: Record<string, string>; side_data_list?: unknown[] };
type Description = { streams: Stream[]; format: { duration?: string; tags?: Record<string, string> }; firstFrameSideData: string[] };

/** What ffprobe says of a converted file: its streams and tags, and the side data on its first video frame. */
async function describeConverted(bytes: Uint8Array): Promise<Description> {
  const path = await saved(bytes, "mp4");
  const base = ["-hide_banner", "-loglevel", "error", "-print_format", "json"];
  const { stdout } = await runFile("ffprobe", [
    ...base,
    ...[
      "-show_entries",
      "format=duration:format_tags:stream=codec_type,codec_name,profile,level,pix_fmt,width,height,channels,avg_frame_rate,duration,color_range,color_space,color_transfer,color_primaries:stream_tags:stream_side_data_list",
    ],
    path,
  ]);
  const frames = await runFile("ffprobe", [
    ...base,
    ...["-select_streams", "v", "-read_intervals", "%+#1", "-show_entries", "frame_side_data=side_data_type", path],
  ]);
  const [firstFrame] = (JSON.parse(frames.stdout).frames ?? []) as { side_data_list?: { side_data_type: string }[] }[];
  return { ...JSON.parse(stdout), firstFrameSideData: (firstFrame?.side_data_list ?? []).map((data) => data.side_data_type) };
}

/** An MP4's (or MOV's) top-level boxes, in order, each with its bytes (ffmpeg notes §5). */
function topLevelBoxes(fileBytes: Buffer): { type: string; bytes: Buffer }[] {
  const boxes: { type: string; bytes: Buffer }[] = [];
  let position = 0;
  while (position + 8 <= fileBytes.length) {
    let size = fileBytes.readUInt32BE(position);
    const type = fileBytes.toString("latin1", position + 4, position + 8);
    if (size === 1) size = Number(fileBytes.readBigUInt64BE(position + 8));
    if (size === 0) size = fileBytes.length - position;
    boxes.push({ type, bytes: fileBytes.subarray(position, position + size) });
    position += size;
  }
  return boxes;
}

/** The location forms a phone writes, found in the file's index (its `moov`), where metadata lives. */
function locationsIn(fileBytes: Buffer): string[] {
  const index = topLevelBoxes(fileBytes).find((box) => box.type === "moov")?.bytes ?? Buffer.alloc(0);
  const forms: [string, Buffer][] = [
    ["©xyz", Buffer.from([0xa9, 0x78, 0x79, 0x7a])],
    ["loci", Buffer.from("loci")],
    ["ISO6709", Buffer.from("com.apple.quicktime.location.ISO6709")],
    ["coordinates", Buffer.from("+05.6037")],
  ];
  return forms.filter(([, bytes]) => index.includes(bytes)).map(([name]) => name);
}

const videoOf = (description: Description) => description.streams.find((stream) => stream.codec_type === "video") as Stream;
const audiosOf = (description: Description) => description.streams.filter((stream) => stream.codec_type === "audio");
/** The HDR side data that mustn't reach an SDR file (ffmpeg notes §4.6). */
const HDR_SIDE_DATA = /mastering|light level|ambient|dolby|dovi|hdr10|dynamic/i;

it.skipIf(!inWorkerImage)("runs on the worker image's ffmpeg 7.1, which the conversion and its memory cap were measured on", () => {
  expect(versionLine).toMatch(/^ffmpeg version 7\.1\./);
});

describe("outputProblem: exiting 0 isn't success (ffmpeg notes §4.17)", () => {
  const output = (video: Record<string, unknown> = {}, audio: Record<string, unknown> | null = {}, duration = "3.008000") => ({
    format: { duration },
    streams: [
      { codec_type: "video", codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: 1080, height: 1920, duration: "3.000000", ...video },
      ...(audio === null ? [] : [{ codec_type: "audio", codec_name: "aac", profile: "LC", duration: "3.008000", ...audio }]),
    ],
  });
  const expected = { length: { streamSeconds: 3, containerSeconds: null }, audio: true };
  const expecting = (streamSeconds: number | null, containerSeconds: number | null = null, audio = true) => ({
    length: { streamSeconds, containerSeconds },
    audio,
  });

  it("passes H.264 High in 8-bit 4:2:0, even-sided within 1920 × 1080 either way up, as long as the original, with AAC", () => {
    expect(outputProblem(output(), expected)).toBeNull();
    expect(outputProblem(output({ width: 1920, height: 1080 }), expected)).toBeNull();
    expect(outputProblem(output({ duration: "3.450000" }), expected)).toBeNull();
    expect(outputProblem(output({}, null), expecting(3, null, false))).toBeNull();
  });

  it("refuses anything else, saying what", () => {
    const problems: [string, unknown, ReturnType<typeof expecting>, RegExp][] = [
      ["High 10", output({ profile: "High 10" }), expected, /profile is High 10, not High/],
      ["10-bit", output({ pix_fmt: "yuv420p10le" }), expected, /yuv420p10le, not yuv420p/],
      ["HEVC", output({ codec_name: "hevc" }), expected, /hevc, not H.264/],
      ["an odd side", output({ width: 1079 }), expected, /1079 × 1920, not even-sided/],
      ["too large", output({ width: 2160, height: 3840 }), expected, /2160 × 3840/],
      ["no audio", output({}, null), expected, /no AAC audio/],
      ["MP3 audio", output({}, { codec_name: "mp3" }), expected, /no AAC audio/],
      ["half as long", output({ duration: "1.500000" }, {}, "1.500000"), expected, /video is 1\.50 s long, the original's 3\.00 s/],
      ["no duration", { ...output({ duration: undefined }), format: {} }, expected, /video has no duration/],
      // A WebM original gives only its container's length: the converted file's is what is compared.
      ["a WebM's half", output({}, {}, "1.500000"), expecting(null, 3), /file is 1\.50 s long, the original's 3\.00 s/],
      ["a WebM's, with no length", { ...output(), format: {} }, expecting(null, 3), /file has no duration/],
      ["no video", { format: {}, streams: [] }, expected, /0 video streams/],
      ["nothing ffprobe could say", null, expected, /couldn't describe/],
    ];
    for (const [what, json, expecting, message] of problems) {
      expect(outputProblem(json, expecting), what).toMatch(message);
    }
  });

  it("compares like with like: the video stream's length when the original gave one, else the whole file's (Matroska, WebM)", () => {
    // The original's video is 3 s and its file 3.5 s (its audio runs on): each compared with its own kind.
    expect(outputProblem(output({ duration: "3.000000" }, {}, "3.500000"), expecting(3, null))).toBeNull();
    expect(outputProblem(output({ duration: "2.900000" }, {}, "3.500000"), expecting(null, 3.5))).toBeNull();
    expect(outputProblem(output({ duration: "3.000000" }, {}, "3.500000"), expecting(null, 3))).toBeNull();
    expect(outputProblem(output({ duration: "3.000000" }, {}, "4.200000"), expecting(null, 3))).toMatch(/file is 4\.20 s long/);
  });

  it("skips the length check only when the original's length is unknown (a browser's WebM)", () => {
    expect(outputProblem(output({ duration: "1.500000" }, {}, "1.500000"), expecting(null, null))).toBeNull();
  });
});

describe("conversionCpuSeconds: the conversion's CPU time, sized from its length and frame rate (Ruling AR)", () => {
  it("gives ten minutes and 30 CPU-seconds a second of video at 30 fps, or below", () => {
    expect(conversionCpuSeconds(81.3, 30, 1800)).toBe(600 + 2439);
    expect(conversionCpuSeconds(10, 24, 1800)).toBe(900);
    expect(conversionCpuSeconds(10, null, 1800)).toBe(900);
  });

  it("gives more in proportion to the frames read: twice at 60 fps, eight times for 240 fps slow motion", () => {
    expect(conversionCpuSeconds(10, 60, 1800)).toBe(600 + 600);
    expect(conversionCpuSeconds(10, 240, 1800)).toBe(600 + 2400);
    expect(conversionCpuSeconds(10, 59.94, 1800)).toBe(Math.ceil(600 + 10 * 30 * (59.94 / 30)));
  });

  it("gives a video of no known length the longest's", () => {
    expect(conversionCpuSeconds(null, 30, 1800)).toBe(600 + 1800 * 30);
  });
});

describe("conversionMilliseconds: the conversion's time, sized from its measured speed", () => {
  it("gives ten seconds a second of video and ten minutes more, never past three hours", () => {
    expect(conversionMilliseconds(10)).toBe(10 * 60_000 + 100_000);
    expect(conversionMilliseconds(180)).toBe(10 * 60_000 + 1_800_000);
    expect(conversionMilliseconds(4 * 3600)).toBe(3 * 3600_000);
    expect(conversionMilliseconds(null)).toBe(3 * 3600_000);
  });

  it("leaves an hour of the job's four for the download, the upload and the rest", () => {
    const jobMilliseconds = (MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.convert].expireInSeconds ?? 0) * 1000;
    expect(jobMilliseconds).toBe(14_400_000);
    expect(conversionMilliseconds(null) + 3600_000).toBeLessThanOrEqual(jobMilliseconds);
  });
});

describe.skipIf(!ffmpegSeven)("a conversion every phone plays (Review Focus 2)", () => {
  it("makes an iPhone's rotated HLG clip H.264 High, upright 1080 × 1920, SDR BT.709, AAC stereo, faststart, with its capture time and no location", async () => {
    const original = await iphoneClip();
    // The fixture is what it claims: an iPhone's location key and its coordinates in the index, turned −90.
    expect(locationsIn(original)).toEqual(expect.arrayContaining(["ISO6709", "coordinates"]));
    const mediaId = await readyVideo(original, "mov");

    const report = await convertVideo(convertJob(mediaId), convertOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", conversion: "done", width: 1080, height: 1920 });
    // The poster's files are kept beside it.
    expect(Object.keys(item.derived).sort()).toEqual(["poster-thumb", "poster-view", "video"]);
    // Under its settings' second version (Task 14b), so no cache has the first's: uncapped, as by default.
    const { etag } = (await headOriginal(item.originalKey)) ?? { etag: "" };
    expect(item.derived.video).toBe(`derived/${mediaId}/${contentHashOf(etag, "convert-settings-2", 0)}/video.mp4`);
    const converted = await readPublic(item.derived.video ?? "");
    expect(converted.contentType).toBe("video/mp4");
    expect(converted.cacheControl).toBe("public, max-age=31536000, immutable");

    const description = await describeConverted(converted.bytes);
    const video = videoOf(description);
    expect(video).toMatchObject({
      codec_name: "h264",
      profile: "High",
      pix_fmt: "yuv420p",
      width: 1080,
      height: 1920,
      color_range: "tv",
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
    });
    expect(Number(video.level)).toBeLessThanOrEqual(40);
    // Turned once, by autorotate: no display matrix left, and no HDR side data on the stream or its frames.
    expect(video.side_data_list).toBeUndefined();
    expect(description.firstFrameSideData.filter((type) => HDR_SIDE_DATA.test(type))).toEqual([]);
    expect(audiosOf(description)).toEqual([expect.objectContaining({ codec_name: "aac", channels: 2 })]);
    expect(Number(description.format.duration)).toBeCloseTo(2, 0);
    // moov before mdat: a phone plays it while it downloads.
    const boxes = topLevelBoxes(converted.bytes).map((box) => box.type);
    expect(boxes.slice(0, 2)).toEqual(["ftyp", "moov"]);
    expect(boxes.indexOf("mdat")).toBeGreaterThan(boxes.indexOf("moov"));
    // Its capture time, as the poster job settled it, and nothing else of the original's.
    expect(locationsIn(converted.bytes)).toEqual([]);
    expect(description.format.tags).toMatchObject({ creation_time: "2026-12-05T23:00:00.000000Z" });
    expect(JSON.stringify(description)).not.toMatch(/location|ISO6709|creationdate|05\.6037/i);
    // Nor the phone that made it: Apple's make, model and software keys, which the original has.
    expect(PHONE_KEYS.test(original.toString("latin1"))).toBe(true);
    expect(JSON.stringify(description)).not.toMatch(PHONE_KEYS);
    expect(PHONE_KEYS.test(converted.bytes.toString("latin1"))).toBe(false);
    expect(video.tags).toMatchObject({ creation_time: "2026-12-05T23:00:00.000000Z" });

    expect(report).toEqual({ sizeBytes: original.length, kind: "video/hevc-hdr" });
    // The manifest is written again once it is done.
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "reception", hiddenAt: null });
  });

  it("runs ffmpeg as the ffmpeg notes' §2.3 says: nice'd, capped, on pinned threads, from a scratch file only", async () => {
    const mediaId = await readyVideo(await iphoneClip(), "mov");

    await convertVideo(convertJob(mediaId), convertOptions());

    const [run] = conversionRuns();
    expect(run.priority).toBe("background");
    // Its memory cap, and its CPU time (Ruling AR): ten minutes and 30 CPU-seconds a second of its
    // 2 s at 30 fps, the hard limit a minute past the soft one, so ffmpeg is told (SIGXCPU) before it is killed.
    expect(run.args.slice(0, 2)).toEqual(["prlimit", `--as=${3 * 1024 ** 3}`]);
    const [soft, hard] = (/^--cpu=(\d+):(\d+)$/.exec(run.args[2]) ?? []).slice(1).map(Number);
    expect(soft).toBeGreaterThanOrEqual(660);
    expect(soft).toBeLessThanOrEqual(666);
    expect(hard).toBe(soft + 60);
    expect(run.args.slice(3, 5)).toEqual(["--", "ffmpeg"]);
    const args = run.args.slice(5);
    const input = args.indexOf("-i");
    const valueAfter = (flag: string, from = 0) => args[args.indexOf(flag, from) + 1];
    for (const flag of ["-hide_banner", "-nostdin", "-nostats", "-xerror", "-y"]) expect(args.indexOf(flag)).toBeLessThan(input);
    expect(valueAfter("-loglevel")).toBe("error");
    expect(valueAfter("-filter_threads")).toBe("1");
    expect(valueAfter("-protocol_whitelist")).toBe("file");
    expect(valueAfter("-format_whitelist")).toBe("mov,matroska");
    // The decoder's threads before the input, x264's after it (ffmpeg notes §4.14): alone, every CPU (WORKER_CPUS).
    expect(args[input - 2]).toBe("-threads");
    expect(args[input - 1]).toBe("3");
    expect(valueAfter("-threads", input)).toBe("3");
    expect(args[input + 1]).toMatch(/\/original$/);
    expect(args.slice(input + 2, input + 6)).toEqual(["-map", "0:0", "-map", "0:1"]);
    expect(valueAfter("-map_metadata")).toBe("-1");
    expect(valueAfter("-map_chapters")).toBe("-1");
    expect(valueAfter("-fpsmax")).toBe("30");
    expect(valueAfter("-c:v")).toBe("libx264");
    expect(valueAfter("-preset")).toBe("veryfast");
    expect(valueAfter("-crf")).toBe("23");
    // Pure CRF 23: no cap unless WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE are set (Noblet).
    expect(args.join(" ")).not.toMatch(/-maxrate|-bufsize/);
    expect(valueAfter("-profile:v")).toBe("high");
    expect(args).not.toContain("-level");
    expect(args).not.toContain("-level:v");
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 6)).toEqual(["-c:a", "aac", "-b:a", "128k", "-ac", "2"]);
    expect(valueAfter("-metadata")).toBe(`creation_time=${CAPTURED_AT.toISOString()}`);
    expect(args.slice(-5)).toEqual(["-movflags", "+faststart", "-f", "mp4", expect.stringMatching(/\/converted\.mp4$/)]);
    // The orientation-aware fit (ffmpeg notes §4.11), HLG tone-mapped, side data deleted; never a turn of our own.
    const filters = valueAfter("-vf");
    expect(filters).toMatch(/^scale=w='if\(gte\(iw,ih\),min\(1920,iw\),min\(1080,iw\)\)':h='if\(gte\(iw,ih\),min\(1080,ih\),min\(1920,ih\)\)'/);
    expect(filters).toContain("zscale=tin=arib-std-b67:min=2020_ncl:pin=2020:rin=limited:t=linear:npl=100");
    expect(filters).toContain("tonemap=tonemap=hable:desat=0");
    expect(filters).toContain("sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA");
    expect(filters).not.toMatch(/transpose|rotate|flip/);
    expect(args).not.toContain("-noautorotate");
    // Its probes too run nice'd, under the probe's cap, from the scratch file only.
    const probes = programs.runs.filter((program) => program.args.includes("ffprobe"));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.priority).toBe("background");
      expect(probe.args.slice(0, 4)).toEqual(["prlimit", `--as=${2 * 1024 ** 3}`, "--", "ffprobe"]);
      expect(probe.args[probe.args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    }
    // It asked the scratch disk for twice the original's size, and more.
    const [bytesNeeded] = scratch.bytesNeeded;
    expect(bytesNeeded).toBeGreaterThanOrEqual(2 * (await readItem(mediaId)).sizeBytes);
  });

  it("caps its bitrate when WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE are set, under keys of their own", async () => {
    const mediaId = await readyVideo(await androidClip(), "mov", { width: 640, height: 360, videoCodec: "h264" });
    const capped = convertOptions({ x264Cap: { maxRate: "5M", bufferSize: "10M" } });

    await convertVideo(convertJob(mediaId), capped);

    const args = conversionRuns()[0].args;
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    expect(valueAfter("-crf")).toBe("23");
    expect(valueAfter("-maxrate:v")).toBe("5M");
    expect(valueAfter("-bufsize:v")).toBe("10M");
    expect(args.indexOf("-maxrate:v")).toBeGreaterThan(args.indexOf("-c:v"));
    const item = await readItem(mediaId);
    const { etag } = (await headOriginal(item.originalKey)) ?? { etag: "" };
    expect(item.derived.video).toBe(`derived/${mediaId}/${contentHashOf(etag, "convert-settings-2-maxrate-5M-bufsize-10M", 0)}/video.mp4`);
  });

  it("deletes a PQ clip's mastering display and light levels, which an SDR file mustn't carry (ffmpeg notes §4.6)", async () => {
    const original = await pqClip();
    const mediaId = await readyVideo(original, "mov");

    await convertVideo(convertJob(mediaId), convertOptions());

    const description = await describeConverted((await readPublic((await readItem(mediaId)).derived.video ?? "")).bytes);
    expect(videoOf(description)).toMatchObject({ width: 1280, height: 720, color_transfer: "bt709", profile: "High" });
    expect(videoOf(description).side_data_list).toBeUndefined();
    expect(description.firstFrameSideData.filter((type) => HDR_SIDE_DATA.test(type))).toEqual([]);
    expect(audiosOf(description)).toEqual([]);
    expect(conversionRuns()[0].args).not.toContain("-c:a");
  });

  it("makes an Android phone's full-range clip limited-range BT.709, never enlarged, with no `©xyz` location", async () => {
    const original = await androidClip();
    expect(locationsIn(original)).toEqual(expect.arrayContaining(["©xyz", "coordinates"]));
    const mediaId = await readyVideo(original, "mov", { width: 640, height: 360, videoCodec: "h264" });

    const report = await convertVideo(convertJob(mediaId), convertOptions());

    const bytes = (await readPublic((await readItem(mediaId)).derived.video ?? "")).bytes;
    const description = await describeConverted(bytes);
    expect(videoOf(description)).toMatchObject({
      width: 640,
      height: 360,
      pix_fmt: "yuv420p",
      color_range: "tv",
      color_space: "bt709",
      color_primaries: "bt709",
      color_transfer: "bt709",
    });
    expect(locationsIn(bytes)).toEqual([]);
    expect(report).toMatchObject({ kind: "video/h264" });
    expect(conversionRuns()[0].args.join(" ")).toContain(":in_color_matrix=bt709:in_range=pc:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=");
  });

  it("brings 60 fps down to 30 (H.264 level 4.0), with no audio stream and no creation time when neither is known", async () => {
    const original = await sixtyFramesClip();
    expect(locationsIn(original)).toEqual(expect.arrayContaining(["loci"]));
    const mediaId = await readyVideo(original, "mp4", { width: 1920, height: 1080, videoCodec: "h264", capturedAt: null });

    await convertVideo(convertJob(mediaId), convertOptions());

    const bytes = (await readPublic((await readItem(mediaId)).derived.video ?? "")).bytes;
    const description = await describeConverted(bytes);
    expect(videoOf(description)).toMatchObject({ width: 1920, height: 1080, avg_frame_rate: "30/1", level: 40 });
    expect(audiosOf(description)).toEqual([]);
    expect(description.format.tags?.creation_time).toBeUndefined();
    expect(locationsIn(bytes)).toEqual([]);
    expect(conversionRuns()[0].args).not.toContain("-metadata");
  });
});

/** The conversion's lease and state, as the row has them. */
async function leaseOf(mediaId: string) {
  const [row] = await getDb()
    .select({ conversion: media.conversion, lease: media.conversionJobId, reason: media.conversionFailureReason })
    .from(media)
    .where(eq(media.id, mediaId));
  return row;
}

/** Polls until `check` passes or `timeoutMilliseconds` runs out, then runs it once more to report. */
async function eventually(check: () => Promise<void>, timeoutMilliseconds = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** The worker's queue workers with the real conversion handler, as main.ts starts them. */
async function startConversions(): Promise<QueueWorkers> {
  workers = await startQueueWorkers(
    boss,
    { [MEDIA_QUEUES.convert]: convertHandler(convertOptions()) },
    { photo: 1, jpeg: 1, poster: 1, wish: 1, visibility: 1, card: 1, convertOnDemand: 1, convertBacklog: 1, playable: 1 },
    { pollingIntervalSeconds: 0.5 },
  );
  return workers;
}

describe("conversionThreads: a lone conversion takes every CPU, two share them (Task 14b, Ruling R)", () => {
  const options = { cpus: 3, decoderThreads: 2, x264Threads: 2, filterThreads: 1 };

  it("gives a conversion that starts alone WORKER_CPUS for its decoder and for x264", () => {
    expect(conversionThreads(0, options)).toMatchObject({ decoder: 3, x264: 3 });
    expect(conversionThreads(0, { ...options, cpus: 16 })).toMatchObject({ decoder: 16, x264: 16 });
  });

  it("gives one that starts beside another the shared counts, WORKER_FFMPEG_DECODER_THREADS and WORKER_X264_THREADS", () => {
    expect(conversionThreads(1, options)).toEqual({ decoder: 2, x264: 2, filter: 1 });
    expect(conversionThreads(2, options)).toEqual({ decoder: 2, x264: 2, filter: 1 });
  });
});

describe.skipIf(!ffmpegSeven)("conversions that overlap (Task 14b)", () => {
  it("pick their threads by how many run as each starts: 3 alone, 2 each for two, and 3 again once the box is free", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // The first runs long enough for the second to start beside it.
    const flat = await saved(await hlgClip("1920x1080", 4, { grain: true }), "mov");
    const first = await readyVideo(await clip("first.mov", ["-display_rotation", "-90", "-i", flat, "-c", "copy"]), "mov");
    const second = await readyVideo(await androidClip(), "mov", { width: 640, height: 360, videoCodec: "h264" });
    const third = await readyVideo(await androidClip(), "mov", { width: 640, height: 360, videoCodec: "h264" });

    const firstConverting = convertVideo(convertJob(first), convertOptions());
    const deadline = Date.now() + 120_000;
    while (!conversionRuns().some((run) => run.args.includes("libx264")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await convertVideo(convertJob(second), convertOptions());
    const firstStillConverting = (await readItem(first)).conversion === "converting";
    await firstConverting;
    await convertVideo(convertJob(third), convertOptions());

    const threadsOf = (run: ProgramRun) => {
      const args = run.args;
      const input = args.indexOf("-i");
      return { decoder: args[args.lastIndexOf("-threads", input) + 1], x264: args[args.indexOf("-threads", input) + 1] };
    };
    const [firstRun, secondRun, thirdRun] = conversionRuns().filter((run) => run.args.includes("libx264"));
    expect(firstStillConverting).toBe(true);
    expect(threadsOf(firstRun)).toEqual({ decoder: "3", x264: "3" });
    expect(threadsOf(secondRun)).toEqual({ decoder: "2", x264: "2" });
    expect(threadsOf(thirdRun)).toEqual({ decoder: "3", x264: "3" });
    for (const mediaId of [first, second, third]) expect((await readItem(mediaId)).conversion, mediaId).toBe("done");
  }, 300_000);
});

describe.skipIf(!ffmpegSeven)("a conversion that fails", () => {
  it("is retried when the original was cut short (it passes ffprobe), still converting under its job's lease, and is corrupt for good on its third attempt", async () => {
    const mediaId = await readyVideo(await truncatedClip(), "mp4", { width: 640, height: 360 });
    const jobId = randomUUID();

    for (const retryCount of [0, 1]) {
      const error = await failureOf(mediaId, retryCount, convertOptions(), jobId);
      expect(error, `attempt ${retryCount + 1}`).not.toBeInstanceOf(PermanentJobError);
      expect(error?.message).toMatch(/^ffmpeg /);
      // Its retry carries it on; any other job finds it taken (Ruling AQ).
      expect(await leaseOf(mediaId)).toMatchObject({ conversion: "converting", lease: jobId });
    }
    const last = await failureOf(mediaId, 2, convertOptions(), jobId);
    expect(last).toBeInstanceOf(PermanentJobError);
    expect((last as PermanentJobError).reason).toBe("corrupt");
    // Left for media.dead to mark failed (markConversionFailed); the video keeps its poster.
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", conversion: "converting" });
    expect(Object.keys((await readItem(mediaId)).derived)).not.toContain("video");
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it("is marked failed, with its reason, through the queue once it fails for good, and the video stays ready with its poster", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await startConversions();
    // A JPEG with a video's name: unsupported-type, at once.
    const jpeg = await clip("photo.jpg", ["-f", "lavfi", "-i", "testsrc2=size=640x480", "-frames:v", "1"]);
    const mediaId = await readyVideo(jpeg, "mp4");
    await boss.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.onDemand });

    await eventually(async () => expect((await readItem(mediaId)).conversion).toBe("failed"), 30_000);
    expect(await readItem(mediaId)).toMatchObject({
      status: "ready",
      conversion: "failed",
      conversionFailureReason: "unsupported-type",
      failureReason: null,
    });
    expect(Object.keys((await readItem(mediaId)).derived).sort()).toEqual(["poster-thumb", "poster-view"]);
  });

  it("is retried, never published, when ffmpeg can't convert within its memory cap", async () => {
    const mediaId = await readyVideo(await iphoneClip(), "mov");
    const jobId = randomUUID();

    const error = await failureOf(mediaId, 0, convertOptions({ convertMemoryBytes: 400 * 1024 * 1024 }), jobId);

    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(error?.message).toMatch(/^ffmpeg /);
    expect(conversionRuns()[0].args.slice(0, 2)).toEqual(["prlimit", `--as=${400 * 1024 * 1024}`]);
    expect(await leaseOf(mediaId)).toMatchObject({ conversion: "converting", lease: jobId });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });

  it("is stopped by its CPU-time limit, which a busy box can't use up, and blamed on the file from its third attempt (Ruling AR)", async () => {
    // The real ffmpeg 7.1 under prlimit --cpu: a 4K encode far past one CPU-second.
    const encode = (retryCount: number) =>
      runVideoTool(
        "ffmpeg",
        [
          ...["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-xerror", "-y"],
          ...["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30", "-t", "60"],
          ...["-c:v", "libx264", "-preset", "medium", "-threads", "2", "-f", "mp4", join(folder, `${randomUUID()}.mp4`)],
        ],
        {
          memoryBytes: 3 * 1024 ** 3,
          cpuSeconds: 1,
          signal: AbortSignal.timeout(120_000),
          folder,
          retryCount,
          priority: "background",
          source: "scratch",
        },
        120_000,
      ).then(
        () => null,
        (error: unknown) => error as Error,
      );

    const early = await encode(0);
    expect(early).not.toBeInstanceOf(PermanentJobError);
    expect(early?.message).toMatch(/^ffmpeg used up its 1 s of CPU time on the video/);
    const last = await encode(2);
    expect(last).toBeInstanceOf(PermanentJobError);
    expect((last as PermanentJobError).reason).toBe("corrupt");
    expect(programs.runs.at(-1)?.args.slice(0, 3)).toEqual(["prlimit", `--as=${3 * 1024 ** 3}`, "--cpu=1:61"]);
  });

  it("removes its scratch folder however it ends: done, a file ffmpeg refuses, or killed mid-conversion by its job's end", async () => {
    const done = await readyVideo(await androidClip(), "mov");
    await convertVideo(convertJob(done), convertOptions());
    const random = await readyVideo(randomBytes(64 * 1024), "mp4");
    await failureOf(random);

    // Killed once ffmpeg is converting: the job expired, or the worker is stopping.
    const killed = await readyVideo(await iphoneClip(), "mov");
    const ending = new AbortController();
    const conversionsBefore = conversionRuns().length;
    const converting = convertVideo(convertJob(killed, 0, { signal: ending.signal }), convertOptions());
    const deadline = Date.now() + 60_000;
    while (conversionRuns().length === conversionsBefore && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ending.abort();
    const error = await converting.then(
      () => null,
      (failure: unknown) => failure as Error,
    );

    expect(error).not.toBeInstanceOf(PermanentJobError);
    expect(error?.message).toMatch(/ffmpeg didn't finish with the video: it was killed \(aborted\)/);
    // Its job's retry carries it on.
    expect(await readItem(killed)).toMatchObject({ conversion: "converting" });
    expect(await readdir(scratchRoot)).toEqual([]);
  });
});

describe.skipIf(!ffmpegSeven)("a video too long to convert (Ruling AR)", () => {
  it("fails at once, too-long, before any download, when its poster's probe already says it is longer than the worker converts", async () => {
    const mediaId = await readyVideo(await androidClip(), "mov", { durationSeconds: 2 });

    const error = await failureOf(mediaId, 0, convertOptions({ convertMaxSeconds: 1 }));

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error).toMatchObject({ reason: "too-long" });
    expect(programs.runs).toEqual([]);
    expect(scratch.bytesNeeded).toEqual([]);
  });

  it("fails at once, too-long, when only the file itself says so, its scratch removed", async () => {
    const mediaId = await readyVideo(await androidClip(), "mov", { durationSeconds: null });

    const error = await failureOf(mediaId, 0, convertOptions({ convertMaxSeconds: 1 }));

    expect(error).toMatchObject({ reason: "too-long" });
    expect(conversionRuns()).toEqual([]);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("is marked failed, too-long, through the queue, with no retries: the video stays ready with its poster and its original", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A 31-minute video, by its poster's probe: past the default 30.
    const mediaId = await readyVideo(randomBytes(1024), "mp4", { durationSeconds: 31 * 60 });
    await startConversions();
    const jobId = await boss.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.onDemand });

    await eventually(async () => expect(await leaseOf(mediaId)).toMatchObject({ conversion: "failed", reason: "too-long" }), 30_000);
    const [job] = await boss.findJobs(MEDIA_QUEUES.convert, { id: jobId ?? "" });
    expect(job).toMatchObject({ state: "failed", retryCount: 0 });
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", failureReason: null });
    expect(programs.runs).toEqual([]);
  });
});

describe.skipIf(!ffmpegSeven)("a conversion job delivered twice, late, or for a video that has moved on (Rulings AG and AQ)", () => {
  it("does nothing, and runs nothing, unless the conversion is queued (or under its own lease) and the video ready and visible", async () => {
    const bytes = randomBytes(1024);
    const items = [
      await readyVideo(bytes, "mp4", { conversion: "none" }),
      await readyVideo(bytes, "mp4", { conversion: "done", derived: { video: "derived/x/0000000000000000/video.mp4" } }),
      await readyVideo(bytes, "mp4", { conversion: "failed" }),
      // Another job holds its lease: any other job, whatever its attempt, leaves it alone.
      await readyVideo(bytes, "mp4", { conversion: "converting", conversionJobId: randomUUID() }),
      await readyVideo(bytes, "mp4", { hiddenAt: new Date(), hiddenBy: "admin" }),
      await readyVideo(bytes, "mp4", { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await readyVideo(bytes, "mp4", { deletedAt: new Date() }),
      await readyVideo(bytes, "mp4", { status: "uploaded", listedAt: null }),
      await readyVideo(bytes, "jpg", { kind: "photo", contentType: "image/jpeg" }),
    ];
    const before = await Promise.all(items.map(readItem));

    for (const mediaId of [...items, randomUUID(), "not-an-id"]) {
      for (const retryCount of [0, 3]) {
        expect(await convertVideo(convertJob(mediaId, retryCount), convertOptions())).toBeUndefined();
      }
    }

    expect(programs.runs).toEqual([]);
    expect(scratch.bytesNeeded).toEqual([]);
    expect(await Promise.all(items.map(readItem))).toEqual(before);
  });

  it("carries on a conversion under its own lease (its worker died mid-way), and a second job with another lease never does", async () => {
    const lease = randomUUID();
    const mediaId = await readyVideo(await androidClip(), "mov", { conversion: "converting", conversionJobId: lease });

    // Another job, even on a retry, finds it taken.
    expect(await convertVideo(convertJob(mediaId, 2), convertOptions())).toBeUndefined();
    expect(programs.runs).toEqual([]);
    // Its own job's retry, or a held copy carrying its lease, carries it on.
    await convertVideo({ ...convertJob(mediaId, 0), data: { mediaId, leaseJobId: lease } }, convertOptions());

    expect(await leaseOf(mediaId)).toMatchObject({ conversion: "done", lease });
  });

  it("converts once however often it is delivered: the backlog's job after an on-demand one finished does nothing", async () => {
    const mediaId = await readyVideo(await androidClip(), "mov");

    await convertVideo(convertJob(mediaId), convertOptions());
    const { derived } = await readItem(mediaId);
    const runsAfterFirst = programs.runs.length;
    await convertVideo(convertJob(mediaId), convertOptions());

    expect(programs.runs).toHaveLength(runsAfterFirst);
    expect(await readItem(mediaId)).toMatchObject({ conversion: "done", derived });
  });

  it("never converts twice at once: a second job sent while the first converts does nothing, and the first finishes", async () => {
    const mediaId = await readyVideo(await androidClip(), "mov");
    let secondJob: unknown = "not run";
    publishing.afterPut = async () => {
      const runsBefore = programs.runs.length;
      secondJob = await convertVideo(convertJob(mediaId, 1), convertOptions());
      expect(programs.runs).toHaveLength(runsBefore);
    };

    await convertVideo(convertJob(mediaId), convertOptions());

    expect(secondJob).toBeUndefined();
    const item = await readItem(mediaId);
    expect(item.conversion).toBe("done");
    expect(await publicKeysOf(mediaId)).toEqual([item.derived.video]);
  });

  it("publishes nothing for a video hidden while it converted: its file comes down, and its conversion waits, queued and unleased, for an unhide", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await androidClip(), "mov");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await convertVideo(convertJob(mediaId), convertOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", conversion: "queued", conversionJobId: null });
    expect(item.derived.video).toBeUndefined();
    expect(await publicKeysOf(mediaId)).toEqual([]);
    // The visibility job then purges, and withdraws the poster the hide left.
    const withdrawals = await boss.findJobs(MEDIA_QUEUES.visibility, { data: { mediaId } });
    expect(withdrawals.map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });
});

describe.skipIf(!ffmpegSeven)("a worker that died mid-conversion, then the backlog switched off (Ruling AQ)", () => {
  /**
   * A conversion its job claimed before its worker died: `converting` under the job's lease, the
   * job back in the backlog to retry (pg-boss keeps its id). The switch went off between two
   * heartbeats, so the backlog worker fetches the retry, and holds it.
   */
  async function diedThenSwitchedOff(values: Partial<typeof media.$inferInsert>) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await setSetting("convert_backlog", true);
    const lease = randomUUID();
    const mediaId = await readyVideo(await androidClip(), "mov", { conversion: "converting", conversionJobId: lease, ...values });
    const running = await startConversions();
    await setSetting("convert_backlog", false);
    await boss.send(MEDIA_QUEUES.convert, { mediaId }, { id: lease, priority: CONVERT_PRIORITY.backlog });
    return { mediaId, lease, running };
  }

  it("is finished at once, on demand, when a guest is waiting for it: the held copy carries the lease at priority 20", async () => {
    const { mediaId, lease } = await diedThenSwitchedOff({ conversionRequestedAt: new Date() });

    await eventually(async () => expect(await leaseOf(mediaId)).toMatchObject({ conversion: "done", lease }));
    // While the switch is still off.
    expect(await getSetting("convert_backlog", true)).toBe(false);
  });

  it("is finished once the switch is on again, never stranded converting, when no one is waiting", async () => {
    const { mediaId, lease, running } = await diedThenSwitchedOff({});

    await eventually(async () =>
      expect(
        (await boss.findJobs<{ mediaId: string; leaseJobId?: string }>(MEDIA_QUEUES.convert, { data: { mediaId, leaseJobId: lease } })).map(
          (job) => job.state,
        ),
      ).toEqual(["created"]),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await leaseOf(mediaId)).toMatchObject({ conversion: "converting", lease });

    await setSetting("convert_backlog", true);
    await running.followBacklogSwitch();
    await eventually(async () => expect(await leaseOf(mediaId)).toMatchObject({ conversion: "done", lease }));
  });
});

describe.skipIf(!ffmpegSeven)("Ruling E: a photo stays fast while a real 4K HDR conversion runs", () => {
  it("finishes a 12 MP photo job in under 20 s while an iPhone-like 4K HLG clip converts, nice'd, at the default threads and memory cap", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = workerConfig({});
    // An iPhone's portrait 4K HDR, grain, bitrate and display matrix included: autorotate turns
    // each 4K frame before it is shrunk. Measured at 1.2 to 3 s a second of video on 3 CPUs.
    const flat = await saved(await hlgClip("3840x2160", 6, { grain: true }), "mov");
    const portrait = await clip("portrait.mov", ["-display_rotation", "-90", "-i", flat, "-c", "copy"]);
    const hdr = await readyVideo(portrait, "mov", { width: 2160, height: 3840 });
    const photoBytes = await sharp({
      create: { width: 4032, height: 3024, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: "gaussian", mean: 128, sigma: 40 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const photoId = await uploadedPhoto(photoBytes);
    workers = await startQueueWorkers(
      boss,
      {
        [MEDIA_QUEUES.convert]: convertHandler(convertOptions()),
        [MEDIA_QUEUES.photo]: photoHandler({
          heifMemoryBytes: config.heifMemoryBytes,
          heifThreads: config.threads.heif,
          jobQueue: async () => boss,
        }),
      },
      config.concurrency,
      { pollingIntervalSeconds: 0.5 },
    );

    const convertStartedAt = performance.now();
    await boss.send(MEDIA_QUEUES.convert, { mediaId: hdr }, { priority: CONVERT_PRIORITY.onDemand });
    const deadline = Date.now() + 120_000;
    while (!conversionRuns().some((run) => run.args.includes("libx264")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Let x264 take the CPUs first.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    const photoSentAt = performance.now();
    await boss.send(MEDIA_QUEUES.photo, { mediaId: photoId });
    while ((await readItem(photoId)).status !== "ready" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const photoMilliseconds = performance.now() - photoSentAt;
    const conversionAtPhoto = (await readItem(hdr)).conversion;
    while ((await readItem(hdr)).conversion !== "done" && Date.now() < deadline + 240_000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const conversionTotalMilliseconds = performance.now() - convertStartedAt;
    log.mockRestore();
    console.log(
      `[Ruling E] photo ready in ${Math.round(photoMilliseconds)} ms while the 4K HLG conversion ran (${conversionAtPhoto}); ` +
        `the 6 s clip converted in ${Math.round(conversionTotalMilliseconds)} ms`,
    );

    expect(photoMilliseconds).toBeLessThan(20_000);
    expect(conversionAtPhoto).toBe("converting");
    // The 4K HDR conversion fits the default 3 GiB cap.
    expect(await readItem(hdr)).toMatchObject({ conversion: "done" });
  }, 600_000);
});
