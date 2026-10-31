import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey, publicUrl } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { headOriginal } from "@/lib/storage/objects";
import { resetDb } from "../../../test/db";
import { hideMedia, unhideMedia } from "../../../test/moderation";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { PermanentJobError, type MediaJob } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { convertVideo, type ConvertOptions } from "./convert";
import { containerProblem, copyProblem, makePlayableCopy, streamsCopyable, type PlayableOptions } from "./playable";
import { processVideo, type PosterOptions } from "./poster";
import { contentHashOf } from "./publishing";
import { runVisibilityJob, type VisibilityOptions } from "./visibility";

/*
 * media.playable, a clean copy of every video that plays as it is (Task 14b), against the local
 * MinIO and test database (docker compose up -d db minio && npm run storage:init). Every clip is made
 * here by ffmpeg (Ruling F). Its display matrix and metadata need ffmpeg 7 to make and to read as
 * the worker image does, so the tests that make or copy a clip run where ffmpeg is 7 or later:
 * always in the worker image's test target. The output checks run anywhere.
 */

// The app's and the worker's job queue, played by a real pg-boss in a schema of its own.
const queue = vi.hoisted(() => ({ boss: null as unknown }));
vi.mock("@/lib/jobs/boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/boss")>();
  return {
    ...real,
    getBoss: async () => {
      if (!queue.boss) throw new Error("The test queue isn't started");
      return queue.boss;
    },
  };
});

// A test can act between a file going up and its row being marked (Ruling AG), and count the puts.
const publishing = vi.hoisted(() => ({ afterPut: null as null | (() => Promise<void>), keys: [] as string[] }));
vi.mock("@/lib/storage/objects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/objects")>();
  return {
    ...real,
    putPublicObject: async (...args: Parameters<typeof real.putPublicObject>) => {
      await real.putPublicObject(...args);
      publishing.keys.push(args[0]);
      const afterPut = publishing.afterPut;
      publishing.afterPut = null;
      await afterPut?.();
    },
  };
});

// Every program the jobs run, with its priority, so a test can see how it ran.
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
const ffmpegSeven = inWorkerImage || Number(/ffmpeg version n?(\d+)\./.exec(versionLine)?.[1] ?? 0) >= 7;

const BOSS_SCHEMA = "pgboss_worker_playable_test";
const ADMIN = "couple@example.com";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const CAPTURED_AT = new Date("2026-12-05T23:00:00Z");
/** A location every GPS fixture carries: the venue, in Accra. */
const LOCATION = "+05.6037-000.1870+061.000/";
let boss: PgBoss;
let folder: string;
let scratchRoot: string;
let server: Server;
let visibilityOptions: VisibilityOptions;
let sharpThreads: number;
const purgedUrls: string[] = [];
const privateKeys: string[] = [];

function playableOptions(changes: Partial<PlayableOptions> = {}): PlayableOptions {
  return { ffmpegMemoryBytes: workerConfig({}).ffmpegMemoryBytes, jobQueue: async () => boss, ...changes };
}

function posterOptions(): PosterOptions {
  const config = workerConfig({});
  return {
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    posterThreads: config.threads.poster,
    filterThreads: config.threads.ffmpegFilters,
    jobQueue: async () => boss,
    convertMaxSeconds: config.convertMaxSeconds,
  };
}

/** The production defaults, as main.ts passes them, with whatever the test changes. */
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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "nona-playable-test-"));
  scratchRoot = join(folder, "scratch");
  await prepareScratchRoot(scratchRoot);
  sharpThreads = sharp.concurrency();
  sharp.concurrency(1);
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
  // Cloudflare's purge_cache, played by a local server that records the URLs it is asked to purge.
  server = createServer(async (request, response) => {
    purgedUrls.push(...(JSON.parse(await readBody(request)) as { files: string[] }).files);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ success: true, errors: [], result: { id: "purge" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  visibilityOptions = {
    purge: {
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`,
      env: { NODE_ENV: "production", CF_PURGE_TOKEN: "test-purge-token", CF_ZONE_ID: ZONE_ID },
    },
  };
});

afterAll(async () => {
  sharp.concurrency(sharpThreads);
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
  for (const name of Object.values(MEDIA_QUEUES)) await boss.deleteAllJobs(name);
  publishing.afterPut = null;
  publishing.keys = [];
  programs.runs = [];
  purgedUrls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

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
async function saved(bytes: Uint8Array | string, extension: string): Promise<string> {
  const path = join(folder, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes);
  return path;
}

/**
 * An Android phone's portrait clip: H.264 8-bit 4:2:0 and AAC in a MOV, stored 640 × 360 and shown
 * turned a quarter (its display matrix, +90), with its location as a `©xyz` atom, its creation
 * time, a subtitle track (which a copy for the album leaves out, as it does an iPhone's metadata
 * tracks) and its index after its data, as a phone that didn't ask for faststart writes it.
 */
async function phoneClip(seconds = 3): Promise<Buffer> {
  const subtitles = await saved("1\n00:00:00,000 --> 00:00:02,000\nAma's speech\n", "srt");
  const flat = await saved(
    await clip("flat.mov", [
      ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-i", subtitles, "-map", "0:v", "-map", "1:a", "-map", "2:s"],
      ...["-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-c:s", "mov_text"],
      ...["-metadata", `location=${LOCATION}`, "-metadata", "creation_time=2026-12-05T10:30:00Z", "-f", "mov"],
    ]),
    "mov",
  );
  return clip("portrait.mov", ["-display_rotation", "90", "-i", flat, "-map", "0", "-c", "copy", "-f", "mov"]);
}

/** The HLG signal of ffmpeg notes §5: a test pattern made ARIB STD-B67 / BT.2020 by zscale, tagged so. */
const HLG_FILTERS =
  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=2020:t=arib-std-b67:m=2020_ncl:r=limited,format=yuv420p10le";

/**
 * An iPhone's portrait HDR clip: 10-bit HEVC HLG (hvc1), 1920 × 1080 stored and shown turned −90,
 * with mono AAC, Apple's location key and capture date, and a location tag. With `grain`, it has a
 * camera sensor's noise, kept at 40 Mbit/s, which x264 makes about 9 Mbit/s of at CRF 23 uncapped
 * (measured in the worker image; the first real iPhone conversion came out at 9.8): a clean test
 * pattern, or lighter grain, comes in under the cap anyway. A grainy clip longer than 4 s is the
 * same 4 s looped, by a copy: x265 makes grain slowly.
 */
async function iphoneClip({ seconds = 2, grain = false } = {}): Promise<Buffer> {
  const made = Math.min(seconds, 4);
  const flat = await saved(
    await clip("hlg.mov", [
      ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", String(made), "-vf", grain ? `noise=alls=20:allf=t+u,${HLG_FILTERS}` : HLG_FILTERS],
      ...["-c:v", "libx265", "-preset", "ultrafast"],
      ...[
        "-x265-params",
        `log-level=error:keyint=30:min-keyint=30:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc${grain ? ":bitrate=40000" : ""}`,
      ],
      ...["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"],
      ...["-c:a", "aac", "-ac", "1"],
    ]),
    "mov",
  );
  const loops = Math.ceil(seconds / made) - 1;
  return clip("iphone.mov", [
    ...["-stream_loop", String(loops), "-display_rotation", "-90", "-i", flat, "-c", "copy", "-map_metadata", "-1"],
    ...["-movflags", "use_metadata_tags"],
    ...["-metadata", `com.apple.quicktime.location.ISO6709=${LOCATION}`],
    ...["-metadata", "com.apple.quicktime.creationdate=2026-12-06T01:00:00+0200"],
    ...["-metadata", "com.apple.quicktime.make=Apple", "-metadata", "com.apple.quicktime.model=iPhone 15 Pro"],
    ...["-metadata", "com.apple.quicktime.software=17.1.2"],
    ...["-metadata", `location=${LOCATION}`],
    ...["-f", "mov"],
  ]);
}

/** Apple's keys of the phone that made a clip, which a copy or a conversion must not carry. */
const PHONE_KEYS = /quicktime\.(make|model|software)|iPhone 15 Pro|17\.1\.2/;

/**
 * HEVC an Apple player won't play as it is tagged: in Matroska (no sample entry at all), or in an
 * MP4 tagged hev1 (parameter sets in the stream), turned −90.
 */
async function untaggedHevcClips(): Promise<{ matroska: Buffer; hev1: Buffer }> {
  const hevc = ["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"];
  const encode = ["-t", "2", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-pix_fmt", "yuv420p", "-c:a", "aac"];
  const matroska = await clip("hevc.mkv", [...hevc, ...encode, "-f", "matroska"]);
  const flat = await saved(await clip("hev1.mp4", [...hevc, ...encode, "-tag:v", "hev1", "-f", "mp4"]), "mp4");
  const hev1 = await clip("hev1-turned.mp4", ["-display_rotation", "-90", "-i", flat, "-c", "copy", "-f", "mp4"]);
  return { matroska, hev1 };
}

/** A browser's recording: VP9 and Opus in WebM, which an MP4 doesn't carry as they are. */
function webmClip(): Promise<Buffer> {
  return clip("recording.webm", [
    ...["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-t", "2", "-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-c:a", "libopus", "-f", "webm"],
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

/** The original in the private bucket, and the item's row as the upload API leaves it, plus whatever the test sets. */
async function uploadedVideo(bytes: Uint8Array, extension: string, values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
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
      contentType:
        extension === "mov" ? "video/quicktime" : extension === "webm" ? "video/webm" : extension === "mkv" ? "video/x-matroska" : "video/mp4",
      status: "uploaded",
      startedAt: new Date("2026-12-06T12:00:00Z"),
      uploadedAt: new Date("2026-12-06T12:01:00Z"),
      ...values,
    });
  return id;
}

/** As the poster job leaves a video that plays as it is: ready, listed, its poster's files named, its capture time settled. */
function readyVideo(bytes: Uint8Array, extension: string, values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
  return uploadedVideo(bytes, extension, {
    id,
    status: "ready",
    listedAt: new Date("2026-12-06T12:02:00Z"),
    capturedAt: CAPTURED_AT,
    derived: {
      "poster-thumb": `derived/${id}/0000000000000000/poster-thumb.webp`,
      "poster-view": `derived/${id}/0000000000000000/poster-view.webp`,
    },
    width: 360,
    height: 640,
    videoCodec: "h264",
    browserPlayable: true,
    ...values,
  });
}

/** The job as pg-boss delivers it, on its first attempt unless `retryCount` says otherwise. */
function playableJob(mediaId: string, retryCount = 0, signal = AbortSignal.timeout(300_000)): MediaJob {
  return { id: randomUUID(), queue: MEDIA_QUEUES.playable, data: { mediaId }, signal, retryCount };
}

function jobFor(queueName: MediaQueueName, data: Record<string, unknown>): MediaJob {
  return { id: randomUUID(), queue: queueName as MediaJob["queue"], data, signal: AbortSignal.timeout(300_000), retryCount: 0 };
}

/** Runs every waiting job of this item's on the queue through `run`, as the worker would, and returns how many. */
async function runQueued(queueName: MediaQueueName, mediaId: string, run: (job: MediaJob) => Promise<unknown>): Promise<number> {
  const jobs = await boss.findJobs<Record<string, unknown>>(queueName, { data: { mediaId } });
  const waiting = jobs.filter((job) => job.state === "created");
  for (const job of waiting) {
    await run(jobFor(queueName, job.data));
    await boss.deleteJob(queueName, job.id);
  }
  return waiting.length;
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
  return (listing.Contents ?? []).map((object) => object.Key ?? "").sort();
}

async function readPublic(key: string) {
  const response = await storageClient().send(new GetObjectCommand({ Bucket: storageConfig().publicBucket, Key: key }));
  return {
    bytes: Buffer.from((await response.Body?.transformToByteArray()) ?? []),
    contentType: response.ContentType,
    cacheControl: response.CacheControl,
  };
}

type Stream = Record<string, unknown> & {
  codec_type: string;
  tags?: Record<string, string>;
  side_data_list?: { side_data_type?: string; rotation?: number }[];
};
type Description = { streams: Stream[]; format: { duration?: string; bit_rate?: string; tags?: Record<string, string> } };

/** What ffprobe says of a file: its streams, their tags and side data, and its format's. */
async function probeDescription(bytes: Uint8Array): Promise<Description> {
  const { stdout } = await runFile("ffprobe", [
    ...["-hide_banner", "-loglevel", "error", "-print_format", "json"],
    ...[
      "-show_entries",
      "format=duration,bit_rate:format_tags:stream=codec_type,codec_name,codec_tag_string,profile,pix_fmt,width,height,duration,bit_rate,color_transfer:stream_tags:stream_side_data_list",
    ],
    await saved(bytes, "mp4"),
  ]);
  return JSON.parse(stdout);
}

/** The MD5 of a file's first video stream's packets, as they are: equal for a stream copied bit for bit. */
async function videoPacketsHash(bytes: Uint8Array): Promise<string> {
  const { stdout } = await runFile("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-i", await saved(bytes, "mov")],
    ...["-map", "0:v:0", "-c", "copy", "-f", "md5", "-"],
  ]);
  return stdout.trim();
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
const rotationOf = (stream: Stream) => stream.side_data_list?.find((sideData) => sideData.rotation !== undefined)?.rotation;
const ffmpegRuns = () => programs.runs.filter((run) => run.args.includes("ffmpeg"));

describe("streamsCopyable: what an MP4 carries as it is, for a phone to play", () => {
  it("takes H.264 or HEVC, with AAC or no sound", () => {
    expect(streamsCopyable({ codec: "h264", audioCodec: "aac" })).toBe(true);
    expect(streamsCopyable({ codec: "hevc", audioCodec: "aac" })).toBe(true);
    expect(streamsCopyable({ codec: "hevc", audioCodec: null })).toBe(true);
  });

  it("leaves a browser's VP8, VP9 or AV1, and sound that isn't AAC, to the conversion", () => {
    for (const [codec, audioCodec] of [
      ["vp8", "opus"],
      ["vp9", "opus"],
      ["av1", null],
      ["h264", "opus"],
      ["h264", "amr_nb"],
      ["mpeg4", "aac"],
    ] as const) {
      expect(streamsCopyable({ codec, audioCodec }), `${codec} ${audioCodec}`).toBe(false);
    }
  });
});

describe("copyProblem: a copy is checked before it is published, as a conversion is (ffmpeg notes §4.17)", () => {
  const copy = (video: Partial<Stream> = {}, audio: Partial<Stream> | null = {}, extra: Partial<Stream>[] = []) => ({
    format: { duration: "3.008000" },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        codec_tag_string: "avc1",
        duration: "3.000000",
        side_data_list: [{ side_data_type: "Display Matrix", rotation: 90 }],
        ...video,
      },
      ...(audio === null ? [] : [{ codec_type: "audio", codec_name: "aac", duration: "3.008000", ...audio }]),
      ...extra,
    ],
  });
  const expected = { codec: "h264", audio: true, rotation: 90, length: { streamSeconds: 3, containerSeconds: null } };

  it("passes the original's video, turned as it was, with its AAC, as long as the original", () => {
    expect(copyProblem(copy(), expected)).toBeNull();
    expect(copyProblem(copy({ duration: "3.400000" }), expected)).toBeNull();
    // −90 and 270 are the same turn.
    expect(copyProblem(copy({ side_data_list: [{ rotation: 270 }] }), { ...expected, rotation: -90 })).toBeNull();
    expect(copyProblem(copy({ side_data_list: undefined }, null), { ...expected, rotation: 0, audio: false })).toBeNull();
    expect(copyProblem(copy({ codec_name: "hevc", codec_tag_string: "hvc1" }), { ...expected, codec: "hevc" })).toBeNull();
  });

  it("refuses anything else, saying what", () => {
    const problems: [string, unknown, typeof expected, RegExp][] = [
      ["another codec", copy({ codec_name: "hevc" }), expected, /video is hevc, not the original's h264/],
      ["HEVC left hev1", copy({ codec_name: "hevc", codec_tag_string: "hev1" }), { ...expected, codec: "hevc" }, /hevc is tagged hev1, not hvc1/],
      ["H.264 with no tag", copy({ codec_tag_string: undefined }), expected, /h264 is tagged nothing, not avc1/],
      ["its turn lost", copy({ side_data_list: undefined }), expected, /turns it 0°, the original 90°/],
      ["turned the other way", copy({ side_data_list: [{ rotation: -90 }] }), expected, /turns it 270°, the original 90°/],
      ["no sound", copy({}, null), expected, /no AAC audio/],
      ["sound it shouldn't have", copy(), { ...expected, audio: false }, /1 audio stream/],
      ["a subtitle track", copy({}, {}, [{ codec_type: "subtitle", codec_name: "mov_text" }]), expected, /a subtitle stream/],
      ["a data track", copy({}, {}, [{ codec_type: "data", codec_name: "bin_data" }]), expected, /a data stream/],
      ["half as long", copy({ duration: "1.500000" }), expected, /video is 1\.50 s long, the original's 3\.00 s/],
      ["two videos", copy({}, {}, [{ codec_type: "video", codec_name: "h264" }]), expected, /2 video streams/],
      ["nothing ffprobe could say", null, expected, /couldn't describe/],
    ];
    for (const [what, json, expecting, message] of problems) {
      expect(copyProblem(json, expecting), what).toMatch(message);
    }
  });
});

describe("containerProblem: the copy's own index, read before it is published", () => {
  it("finds a location in any form a phone writes, and an index after the data (no faststart)", async () => {
    const plain = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"];
    const quickTime = await saved(await clip("xyz.mov", [...plain, "-metadata", `location=${LOCATION}`, "-f", "mov"]), "mov");
    const isoMedia = await saved(await clip("loci.mp4", [...plain, "-metadata", `location=${LOCATION}`, "-movflags", "+faststart", "-f", "mp4"]), "mp4");
    const apple = await saved(
      await clip("apple.mov", [
        ...plain,
        ...["-movflags", "use_metadata_tags+faststart", "-metadata", `com.apple.quicktime.location.ISO6709=${LOCATION}`, "-f", "mov"],
      ]),
      "mov",
    );
    const clean = await saved(await clip("clean.mp4", [...plain, "-map_metadata", "-1", "-movflags", "+faststart", "-f", "mp4"]), "mp4");

    expect(await containerProblem(quickTime)).toMatch(/after its data|location/);
    expect(await containerProblem(isoMedia)).toMatch(/location \(loci\)/);
    expect(await containerProblem(apple)).toMatch(/location/);
    expect(await containerProblem(clean)).toBeNull();
    const notFaststart = await saved(await clip("late.mp4", [...plain, "-map_metadata", "-1", "-f", "mp4"]), "mp4");
    expect(await containerProblem(notFaststart)).toMatch(/index \(moov\) comes after its data \(mdat\)/);
  });
});

describe.skipIf(!ffmpegSeven)("a clean playable copy of a video (Task 14b)", () => {
  it("copies a rotated H.264 phone clip as it is: its stream bit for bit, its turn kept, no location, its capture time, moov first, published", async () => {
    const original = await phoneClip();
    // The fixture is what it claims: a `©xyz` location, turned +90, its index after its data, a subtitle track.
    expect(locationsIn(original)).toEqual(expect.arrayContaining(["©xyz", "coordinates"]));
    expect(rotationOf(videoOf(await probeDescription(original)))).toBe(90);
    expect(topLevelBoxes(original).map((box) => box.type).indexOf("mdat")).toBeLessThan(
      topLevelBoxes(original).map((box) => box.type).indexOf("moov"),
    );
    const mediaId = await readyVideo(original, "mov");

    const report = await makePlayableCopy(playableJob(mediaId), playableOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", conversion: "none", browserPlayable: true });
    expect(Object.keys(item.derived).sort()).toEqual(["playable", "poster-thumb", "poster-view"]);
    // Under the content hash of its original, its settings and its generation.
    const { etag } = (await headOriginal(item.originalKey)) ?? { etag: "" };
    expect(item.derived.playable).toBe(`derived/${mediaId}/${contentHashOf(etag, "playable-settings-1", 0)}/playable.mp4`);
    const published = await readPublic(item.derived.playable ?? "");
    expect(published.contentType).toBe("video/mp4");
    expect(published.cacheControl).toBe("public, max-age=31536000, immutable");

    // Stream-copied: the same H.264, packet for packet, and the same sound.
    expect(await videoPacketsHash(published.bytes)).toBe(await videoPacketsHash(original));
    const description = await probeDescription(published.bytes);
    expect(description.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([
      ["video", "h264"],
      ["audio", "aac"],
    ]);
    expect(videoOf(description)).toMatchObject({ width: 640, height: 360, codec_tag_string: "avc1" });
    // The display matrix is side data, not metadata: -c copy keeps it, so players turn it (ffmpeg notes §4.1).
    expect(rotationOf(videoOf(description))).toBe(90);
    // No location, in any form; only the capture time the poster job settled on.
    expect(locationsIn(published.bytes)).toEqual([]);
    expect(JSON.stringify(description)).not.toMatch(/location|ISO6709|05\.6037/i);
    expect(description.format.tags).toMatchObject({ creation_time: "2026-12-05T23:00:00.000000Z" });
    // moov before mdat: a phone plays it while it downloads (ffmpeg notes §4.13).
    const boxes = topLevelBoxes(published.bytes).map((box) => box.type);
    expect(boxes.slice(0, 2)).toEqual(["ftyp", "moov"]);
    expect(boxes.indexOf("mdat")).toBeGreaterThan(boxes.indexOf("moov"));

    expect(report).toEqual({ sizeBytes: original.length, kind: "video/h264" });
    expect(await publicKeysOf(mediaId)).toEqual([item.derived.playable]);
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "reception", hiddenAt: null });
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("runs ffmpeg as the brief says: nice'd, capped, from a scratch file only, the video and its sound copied, no metadata but the capture time", async () => {
    const mediaId = await readyVideo(await phoneClip(), "mov");

    await makePlayableCopy(playableJob(mediaId), playableOptions({ ffmpegMemoryBytes: 1536 * 1024 * 1024 }));

    const [run] = ffmpegRuns();
    expect(run.priority).toBe("background");
    // Its memory cap, and five minutes of CPU time (a 2 GB copy took 7 s), the hard limit a minute on.
    expect(run.args.slice(0, 5)).toEqual(["prlimit", `--as=${1536 * 1024 * 1024}`, "--cpu=300:360", "--", "ffmpeg"]);
    const args = run.args.slice(5);
    const input = args.indexOf("-i");
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    for (const flag of ["-hide_banner", "-nostdin", "-nostats", "-xerror", "-y"]) expect(args.indexOf(flag), flag).toBeLessThan(input);
    expect(valueAfter("-loglevel")).toBe("error");
    expect(valueAfter("-protocol_whitelist")).toBe("file");
    expect(valueAfter("-format_whitelist")).toBe("mov,matroska");
    expect(args[input + 1]).toMatch(/\/original$/);
    // The video and the sound the probe picked, never the subtitle (or an iPhone's metadata) tracks.
    expect(args.slice(input + 2, input + 6)).toEqual(["-map", "0:0", "-map", "0:1"]);
    expect(valueAfter("-c")).toBe("copy");
    // H.264 keeps its avc1: the MP4 muxer refuses hvc1 for it.
    expect(args).not.toContain("-tag:v");
    expect(valueAfter("-map_metadata")).toBe("-1");
    expect(valueAfter("-map_chapters")).toBe("-1");
    expect(valueAfter("-metadata")).toBe(`creation_time=${CAPTURED_AT.toISOString()}`);
    expect(args.slice(-5)).toEqual(["-movflags", "+faststart", "-f", "mp4", expect.stringMatching(/\/playable\.mp4$/)]);
    // Nothing decoded, so no filter, encoder or turn of its own.
    expect(args).not.toContain("-vf");
    expect(args).not.toContain("-noautorotate");
    expect(args.join(" ")).not.toMatch(/libx264|transpose/);
    // Its probes too run nice'd, under the cap, from the scratch file only.
    const probes = programs.runs.filter((program) => program.args.includes("ffprobe"));
    expect(probes).toHaveLength(2);
    for (const probe of probes) {
      expect(probe.priority).toBe("background");
      expect(probe.args.slice(0, 4)).toEqual(["prlimit", `--as=${1536 * 1024 * 1024}`, "--", "ffprobe"]);
      expect(probe.args[probe.args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    }
  });

  it("gives an iPhone's HDR clip both: a copy of its HEVC as it is (hvc1, HLG, turned −90), and its conversion, which a cap, when set, holds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const original = await iphoneClip({ seconds: 20, grain: true });
    const mediaId = await uploadedVideo(original, "mov");

    // The poster job makes it ready and sends both jobs.
    await processVideo(jobFor(MEDIA_QUEUES.poster, { mediaId }), posterOptions());
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", browserPlayable: false, conversion: "queued" });
    expect(await runQueued(MEDIA_QUEUES.playable, mediaId, (job) => makePlayableCopy(job, playableOptions()))).toBe(1);
    // With the cap off by default (pure CRF 23); set here as WORKER_X264_MAXRATE=5M and WORKER_X264_BUFSIZE=10M would.
    const capped = convertOptions({ x264Cap: { maxRate: "5M", bufferSize: "10M" } });
    expect(await runQueued(MEDIA_QUEUES.convert, mediaId, (job) => convertVideo(job, capped))).toBe(1);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", conversion: "done" });
    expect(Object.keys(item.derived).sort()).toEqual(["playable", "poster-thumb", "poster-view", "video"]);

    const copy = await readPublic(item.derived.playable ?? "");
    expect(await videoPacketsHash(copy.bytes)).toBe(await videoPacketsHash(original));
    const copied = videoOf(await probeDescription(copy.bytes));
    expect(copied).toMatchObject({ codec_name: "hevc", codec_tag_string: "hvc1", pix_fmt: "yuv420p10le", color_transfer: "arib-std-b67" });
    expect(rotationOf(copied)).toBe(-90);
    expect(locationsIn(copy.bytes)).toEqual([]);
    expect(JSON.stringify(await probeDescription(copy.bytes))).not.toMatch(/location|ISO6709|creationdate|05\.6037/i);
    // Nor the phone that made it: Apple's make, model and software keys (the fixture has them, as an iPhone's does).
    expect(PHONE_KEYS.test(original.toString("latin1"))).toBe(true);
    expect(JSON.stringify(await probeDescription(copy.bytes))).not.toMatch(PHONE_KEYS);
    expect(PHONE_KEYS.test(copy.bytes.toString("latin1"))).toBe(false);
    // Apple's own date, at its offset: 01:00 on Sunday at +02:00 is 23:00 on Saturday in Accra.
    expect((await probeDescription(copy.bytes)).format.tags).toMatchObject({ creation_time: "2026-12-05T23:00:00.000000Z" });

    // The conversion: 1080p, its bitrate held to the cap on a clip whose detail would take about 9
    // Mbit/s uncapped. x264's VBV (-maxrate 5M -bufsize 10M) lets any stretch of T seconds hold at
    // most 5 Mbit a second plus the 10 Mbit buffer, which starts nearly full: over 20 s, 5.5 Mbit/s.
    const convertedBytes = (await readPublic(item.derived.video ?? "")).bytes;
    const converted = await probeDescription(convertedBytes);
    expect(JSON.stringify(converted)).not.toMatch(PHONE_KEYS);
    expect(PHONE_KEYS.test(convertedBytes.toString("latin1"))).toBe(false);
    const video = videoOf(converted);
    expect(video).toMatchObject({ codec_name: "h264", profile: "High", width: 1080, height: 1920 });
    const bitsPerSecond = Number(video.bit_rate);
    const seconds = Number(video.duration);
    log.mockRestore();
    console.log(
      `[Task 14b] the ${seconds.toFixed(1)} s grainy 1080p HLG clip (${Math.round((original.length * 8) / seconds / 1000)} kbit/s) converted at ${Math.round(bitsPerSecond / 1000)} kbit/s`,
    );
    expect(bitsPerSecond * seconds).toBeLessThanOrEqual(5_000_000 * seconds + 10_000_000);
    // Near the cap: the detail made x264 want more, so the cap, not the CRF, set it.
    expect(bitsPerSecond).toBeGreaterThan(4_500_000);
  }, 600_000);

  it("tags HEVC hvc1 whatever the original's (Matroska's none, an MP4's hev1), its packets and turn as they were", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { matroska, hev1 } = await untaggedHevcClips();
    for (const [what, original, extension, rotation] of [
      ["Matroska", matroska, "mkv", undefined],
      ["hev1", hev1, "mp4", -90],
    ] as const) {
      programs.runs = [];
      const mediaId = await readyVideo(original, extension, { videoCodec: "hevc", browserPlayable: false, width: 640, height: 360 });

      await makePlayableCopy(playableJob(mediaId), playableOptions());

      const copy = await readPublic((await readItem(mediaId)).derived.playable ?? "");
      const video = videoOf(await probeDescription(copy.bytes));
      expect(video, what).toMatchObject({ codec_name: "hevc", codec_tag_string: "hvc1" });
      expect(rotationOf(video), what).toBe(rotation);
      expect(await videoPacketsHash(copy.bytes), what).toBe(await videoPacketsHash(original));
      const args = ffmpegRuns()[0].args;
      expect(args.slice(args.indexOf("-c"), args.indexOf("-c") + 4), what).toEqual(["-c", "copy", "-tag:v", "hvc1"]);
    }
  });

  it("writes no creation_time when no capture time is known", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await phoneClip(), "mov", { capturedAt: null });

    await makePlayableCopy(playableJob(mediaId), playableOptions());

    expect(ffmpegRuns()[0].args).not.toContain("-metadata");
    const description = await probeDescription((await readPublic((await readItem(mediaId)).derived.playable ?? "")).bytes);
    expect(description.format.tags?.creation_time).toBeUndefined();
    expect(videoOf(description).tags?.creation_time).toBeUndefined();
  });

  it("is withdrawn with the rest when the video is hidden, and made again under a new key when it is unhidden", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await uploadedVideo(await phoneClip(), "mov");
    await processVideo(jobFor(MEDIA_QUEUES.poster, { mediaId }), posterOptions());
    expect(await runQueued(MEDIA_QUEUES.playable, mediaId, (job) => makePlayableCopy(job, playableOptions()))).toBe(1);
    const first = (await readItem(mediaId)).derived;
    expect(first.playable).toBeDefined();
    expect(await publicKeysOf(mediaId)).toEqual(Object.values(first).sort());

    await hideMedia(mediaId, { admin: ADMIN });
    expect(await runQueued(MEDIA_QUEUES.visibility, mediaId, (job) => runVisibilityJob(job, visibilityOptions))).toBe(1);

    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(purgedUrls.sort()).toEqual(Object.values(first).map((key) => publicUrl(key)).sort());
    expect(await readItem(mediaId)).toMatchObject({ derived: {}, withdrawingKeys: null });
    // A copy job that arrives while it is hidden does nothing.
    await makePlayableCopy(playableJob(mediaId), playableOptions());
    expect(await publicKeysOf(mediaId)).toEqual([]);

    await unhideMedia(mediaId, ADMIN);
    expect(await runQueued(MEDIA_QUEUES.poster, mediaId, (job) => processVideo(job, posterOptions()))).toBe(1);
    expect(await runQueued(MEDIA_QUEUES.playable, mediaId, (job) => makePlayableCopy(job, playableOptions()))).toBe(1);

    const again = (await readItem(mediaId)).derived;
    expect(again.playable).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/playable\\.mp4$`));
    expect(again.playable).not.toBe(first.playable);
    expect(await publicKeysOf(mediaId)).toEqual(Object.values(again).sort());
    expect((await fetch(publicUrl(again.playable ?? ""), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
  });

  it("publishes nothing for a video hidden while its copy was made: the file comes down, recorded, and its withdrawal is queued", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await phoneClip(), "mov");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin" }).where(eq(media.id, mediaId));
    };

    await makePlayableCopy(playableJob(mediaId), playableOptions());

    const item = await readItem(mediaId);
    expect(item.derived.playable).toBeUndefined();
    expect(item.withdrawingKeys).toEqual([expect.stringMatching(/\/playable\.mp4$/)]);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    const withdrawals = await boss.findJobs(MEDIA_QUEUES.visibility, { data: { mediaId } });
    expect(withdrawals.map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });

  it("publishes nothing for a generation an unhide has replaced while its copy was made: the new one gets a copy of its own", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await phoneClip(), "mov");
    publishing.afterPut = async () => {
      // Hidden and unhidden while it worked: processed again, in a new generation.
      await getDb()
        .update(media)
        .set({ derived: {}, derivedGeneration: 1, status: "uploaded" })
        .where(eq(media.id, mediaId));
    };

    await makePlayableCopy(playableJob(mediaId), playableOptions());

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "uploaded", derivedGeneration: 1, derived: {} });
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(item.withdrawingKeys).toHaveLength(1);
  });

  it("makes the copy once however often it is delivered (Ruling AG), and nothing for a video that isn't ready, visible and in the album", async () => {
    const mediaId = await readyVideo(await phoneClip(), "mov");
    await makePlayableCopy(playableJob(mediaId), playableOptions());
    const { derived } = await readItem(mediaId);
    const runsAfterFirst = programs.runs.length;
    expect(publishing.keys).toEqual([derived.playable]);

    await makePlayableCopy(playableJob(mediaId), playableOptions());
    await makePlayableCopy(playableJob(mediaId, 3), playableOptions());

    expect(programs.runs).toHaveLength(runsAfterFirst);
    expect(publishing.keys).toEqual([derived.playable]);
    expect((await readItem(mediaId)).derived).toEqual(derived);

    programs.runs = [];
    const bytes = randomBytes(1024);
    const items = [
      await readyVideo(bytes, "mp4", { status: "uploaded", listedAt: null }),
      await readyVideo(bytes, "mp4", { status: "failed", failureReason: "corrupt" }),
      await readyVideo(bytes, "mp4", { hiddenAt: new Date(), hiddenBy: "admin" }),
      await readyVideo(bytes, "mp4", { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await readyVideo(bytes, "mp4", { deletedAt: new Date() }),
      await readyVideo(bytes, "jpg", { kind: "photo", contentType: "image/jpeg" }),
      await readyVideo(bytes, "mp4", { purpose: "wish" }),
    ];
    const before = await Promise.all(items.map(readItem));
    for (const id of [...items, randomUUID(), "not-an-id"]) {
      expect(await makePlayableCopy(playableJob(id), playableOptions()), id).toBeUndefined();
    }
    expect(programs.runs).toEqual([]);
    expect(await Promise.all(items.map(readItem))).toEqual(before);
  });

  it("never fails the video: an original it can't copy is retried, blamed from its third attempt, and the video stays ready with its poster and its conversion", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await truncatedClip(), "mp4", { width: 640, height: 360, conversion: "queued" });
    const before = await readItem(mediaId);

    for (const retryCount of [0, 1]) {
      const error = await makePlayableCopy(playableJob(mediaId, retryCount), playableOptions()).then(
        () => null,
        (failure: unknown) => failure as Error,
      );
      expect(error, `attempt ${retryCount + 1}`).not.toBeInstanceOf(PermanentJobError);
      expect(error?.message, `attempt ${retryCount + 1}`).toMatch(/^ffmpeg /);
    }
    const last = await makePlayableCopy(playableJob(mediaId, 2), playableOptions()).then(
      () => null,
      (failure: unknown) => failure as Error,
    );
    expect(last).toBeInstanceOf(PermanentJobError);
    expect((last as PermanentJobError).reason).toBe("corrupt");

    expect(await readItem(mediaId)).toEqual(before);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(await readdir(scratchRoot)).toEqual([]);
  });

  it("makes no copy of a video whose streams an MP4 doesn't carry as they are (a browser's VP9 and Opus): its conversion plays", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await readyVideo(await webmClip(), "webm", { videoCodec: "vp9", browserPlayable: false, conversion: "queued" });

    expect(await makePlayableCopy(playableJob(mediaId), playableOptions())).toBeUndefined();

    expect(ffmpegRuns()).toEqual([]);
    expect((await readItem(mediaId)).derived.playable).toBeUndefined();
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(log.mock.calls.flat().join(" ")).toContain(`media=${mediaId}: no playable copy, as an MP4 doesn't carry vp9 and opus as they are`);
  });
});
