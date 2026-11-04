import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUE_OPTIONS, MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { WISH_SECONDS } from "@/lib/media/limits";
import { storageClient } from "@/lib/storage/client";
import { originalKey, publicUrl } from "@/lib/storage/keys";
import { resetDb } from "../../../test/db";
import { hideWish, unhideWish } from "../../../test/moderation";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { PermanentJobError, type MediaJob } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { runVisibilityJob, type VisibilityOptions } from "./visibility";
import {
  processWish,
  VIDEO_WISH_MILLISECONDS,
  videoWishArgs,
  videoWishProblem,
  voiceArgs,
  voiceFactsFrom,
  voiceProblem,
  wishHandler,
  type WishOptions,
} from "./wish";

/*
 * media.wish (Task 16): a voice or video wish's recording made into what the wall plays, against the
 * local MinIO and test database (docker compose up -d db minio && npm run storage:init). Every
 * recording is made here by ffmpeg, as a browser's MediaRecorder or a phone's own recorder writes
 * it. The conversions need ffmpeg 7 (zscale, -fpsmax, the display matrix), so the tests that run
 * ffmpeg run where it is 7 or later: always in the worker image's test target. The argument and
 * output checks run anywhere.
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

// Every program the job runs, with its priority, so a test can see how it ran.
type ProgramRun = { args: string[]; priority: string; timeoutMilliseconds: number };
const programs = vi.hoisted(() => ({ runs: [] as ProgramRun[] }));
vi.mock("../processes", async (importOriginal) => {
  const real = await importOriginal<typeof import("../processes")>();
  return {
    ...real,
    runProcess: (...args: Parameters<typeof real.runProcess>) => {
      programs.runs.push({ args: [args[0], ...args[1]], priority: args[2].priority, timeoutMilliseconds: args[2].timeoutMilliseconds });
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

const BOSS_SCHEMA = "pgboss_worker_wish_test";
const ADMIN = "couple@example.com";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
/** A location a phone's clip carries: the venue, in Accra. */
const LOCATION = "+05.6037-000.1870+061.000/";
let boss: PgBoss;
let folder: string;
let server: Server;
let visibilityOptions: VisibilityOptions;
let sharpThreads: number;
const purgedUrls: string[] = [];
const privateKeys: string[] = [];

/** The production defaults, as main.ts passes them, with whatever the test changes. */
function wishOptions(changes: Partial<WishOptions> = {}): WishOptions {
  const config = workerConfig({});
  return {
    convertMemoryBytes: config.convertMemoryBytes,
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    decoderThreads: config.threads.decoder,
    x264Threads: config.threads.x264,
    filterThreads: config.threads.ffmpegFilters,
    x264Preset: config.x264Preset,
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
  folder = await mkdtemp(join(tmpdir(), "nona-wish-test-"));
  await prepareScratchRoot(join(folder, "scratch"));
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

/** Makes a recording with ffmpeg in the test's folder and returns its bytes. */
async function recording(name: string, args: string[]): Promise<Buffer> {
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
 * A browser's voice note (Chrome's MediaRecorder): Opus in WebM, written live, so the file says
 * nothing of its length (ffmpeg notes §4.15).
 */
function webmVoice(seconds: number): Promise<Buffer> {
  return recording("voice.webm", [
    ...["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000", "-t", String(seconds)],
    ...["-c:a", "libopus", "-b:a", "32k", "-live", "1", "-f", "webm"],
  ]);
}

/** An iPhone's voice note (Safari's MediaRecorder, or Voice Memos): AAC in an MP4, mono. */
function iphoneVoice(seconds: number): Promise<Buffer> {
  return recording("voice.m4a", [
    ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", String(seconds)],
    ...["-c:a", "aac", "-ac", "1", "-metadata", `location=${LOCATION}`, "-f", "mp4"],
  ]);
}

/** A browser's video message: VP8 or VP9 with Opus in WebM, written live (no length). */
function webmVideo(codec: "libvpx" | "libvpx-vp9", seconds = 3, size = "640x480"): Promise<Buffer> {
  return recording("video.webm", [
    ...["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
    ...["-t", String(seconds), "-c:v", codec, "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M"],
    ...["-c:a", "libopus", "-live", "1", "-f", "webm"],
  ]);
}

/** The HLG signal of ffmpeg notes §5: a test pattern made ARIB STD-B67 / BT.2020 by zscale, tagged so. */
const HLG_FILTERS =
  "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=2020:t=arib-std-b67:m=2020_ncl:r=limited,format=yuv420p10le";

/**
 * What an iPhone's own camera hands the fallback picker: 10-bit HEVC HLG (hvc1) at 60 fps, 1920 ×
 * 1080 stored and shown turned −90 (portrait), with mono AAC, Apple's location key and a location tag.
 */
async function iphoneVideo(seconds = 2): Promise<Buffer> {
  const flat = await saved(
    await recording("hlg.mov", [
      ...["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=60"],
      ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
      ...["-t", String(seconds), "-vf", HLG_FILTERS],
      ...["-c:v", "libx265", "-preset", "ultrafast"],
      ...["-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc"],
      ...["-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1"],
      ...["-c:a", "aac", "-ac", "1"],
    ]),
    "mov",
  );
  return recording("iphone.mov", [
    ...["-display_rotation", "-90", "-i", flat, "-c", "copy", "-map_metadata", "-1"],
    ...["-movflags", "use_metadata_tags"],
    ...["-metadata", `com.apple.quicktime.location.ISO6709=${LOCATION}`],
    ...["-metadata", "com.apple.quicktime.creationdate=2026-12-06T01:00:00+0200"],
    ...["-metadata", `location=${LOCATION}`],
    ...["-f", "mov"],
  ]);
}

/**
 * The original in the private bucket, its row as the upload API leaves it once uploaded, and (unless
 * `linked` is false: an orphan) the wish addWish links it to, which is what has it processed (Ruling CE).
 */
async function uploadedWish(
  bytes: Uint8Array,
  kind: "audio" | "video",
  extension: string,
  values: Partial<typeof media.$inferInsert> = {},
  { linked = true }: { linked?: boolean } = {},
): Promise<string> {
  const id = values.id ?? randomUUID();
  const key = originalKey(id, extension);
  privateKeys.push(key, `manifests/${id}.json`);
  await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: bytes }));
  const contentTypes: Record<string, string> = {
    webm: kind === "audio" ? "audio/webm" : "video/webm",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
  };
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "wish",
      kind,
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "reception",
      originalKey: key,
      originalFilename: `wish.${extension}`,
      sizeBytes: bytes.length,
      contentType: contentTypes[extension] ?? "application/octet-stream",
      status: "uploaded",
      startedAt: new Date("2026-12-06T12:00:00Z"),
      uploadedAt: new Date("2026-12-06T12:01:00Z"),
      ...values,
    });
  if (linked) await getDb().insert(wishes).values({ kind: kind === "audio" ? "voice" : "video", signedAs: "Ama Owusu", mediaId: id });
  return id;
}

/** The wish that names the recording, as addWish left it. */
async function wishFor(mediaId: string): Promise<string> {
  const [row] = await getDb().select({ id: wishes.id }).from(wishes).where(eq(wishes.mediaId, mediaId));
  return row.id;
}

/** The job as pg-boss delivers it, on its first attempt unless `retryCount` says otherwise. */
function wishJob(mediaId: string, retryCount = 0, signal = AbortSignal.timeout(300_000)): MediaJob {
  return { id: randomUUID(), queue: MEDIA_QUEUES.wish, data: { mediaId }, signal, retryCount };
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
type Description = {
  streams: Stream[];
  format: { duration?: string; format_name?: string; tags?: Record<string, string> };
};

/** What ffprobe says of a file: its streams, their tags and side data, and its format's. */
async function probeDescription(bytes: Uint8Array, extension = "mp4"): Promise<Description> {
  const { stdout } = await runFile("ffprobe", [
    ...["-hide_banner", "-loglevel", "error", "-print_format", "json"],
    ...[
      "-show_entries",
      "format=duration,format_name:format_tags:stream=codec_type,codec_name,profile,pix_fmt,width,height,duration,avg_frame_rate,color_space,color_transfer,color_primaries,color_range:stream_tags:stream_side_data_list",
    ],
    await saved(bytes, extension),
  ]);
  return JSON.parse(stdout);
}

/** An MP4's top-level box types, in order (ffmpeg notes §5). */
function topLevelBoxes(fileBytes: Buffer): string[] {
  const boxes: string[] = [];
  let position = 0;
  while (position + 8 <= fileBytes.length) {
    let size = fileBytes.readUInt32BE(position);
    const type = fileBytes.toString("latin1", position + 4, position + 8);
    if (size === 1) size = Number(fileBytes.readBigUInt64BE(position + 8));
    if (size === 0) size = fileBytes.length - position;
    boxes.push(type);
    position += size;
  }
  return boxes;
}

/** The location forms a phone writes, anywhere in the file's bytes. */
function locationsIn(fileBytes: Buffer): string[] {
  const forms: [string, Buffer][] = [
    ["©xyz", Buffer.from([0xa9, 0x78, 0x79, 0x7a])],
    ["loci", Buffer.from("loci")],
    ["ISO6709", Buffer.from("com.apple.quicktime.location.ISO6709")],
    ["coordinates", Buffer.from("+05.6037")],
  ];
  return forms.filter(([, bytes]) => fileBytes.includes(bytes)).map(([name]) => name);
}

const videoOf = (description: Description) => description.streams.find((stream) => stream.codec_type === "video") as Stream;
const audioOf = (description: Description) => description.streams.find((stream) => stream.codec_type === "audio") as Stream;

/** The error a job threw, or a failure when it threw nothing. */
async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the job to fail");
}

const ANY_URL = /[a-z][a-z0-9+.-]*:\/\//i;

describe("voiceFactsFrom: a voice wish has sound and no picture (layer 3)", () => {
  const probe = (streams: Record<string, unknown>[], format: Record<string, unknown> = { format_name: "matroska,webm" }) => ({ format, streams });

  it("takes a recording with sound, preferring AAC, then the default stream, with its length when the file says it", () => {
    expect(voiceFactsFrom(probe([{ index: 0, codec_type: "audio", codec_name: "opus" }]))).toEqual({
      ok: true,
      facts: { audioStreamIndex: 0, audioCodec: "opus", durationSeconds: null, durationEstimated: false },
    });
    expect(
      voiceFactsFrom(
        probe(
          [
            { index: 0, codec_type: "audio", codec_name: "apac", disposition: { default: 1 } },
            { index: 1, codec_type: "audio", codec_name: "aac" },
          ],
          { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "12.500000" },
        ),
      ),
    ).toEqual({ ok: true, facts: { audioStreamIndex: 1, audioCodec: "aac", durationSeconds: 12.5, durationEstimated: false } });
    // An MP3's cover art is a picture, not a video: left behind, as the sound alone is mapped.
    expect(
      voiceFactsFrom(
        probe(
          [
            { index: 0, codec_type: "audio", codec_name: "mp3" },
            { index: 1, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
          ],
          { format_name: "mp3", duration: "4.0" },
        ),
      ),
    ).toMatchObject({ ok: true, facts: { audioStreamIndex: 0, durationEstimated: true } });
  });

  it("marks a length ffprobe only estimates from the bitrate (MP3, AMR, raw AAC), which the made file isn't held to", () => {
    for (const format of ["mp3", "amr", "aac"]) {
      expect(voiceFactsFrom(probe([{ index: 0, codec_type: "audio", codec_name: "mp3" }], { format_name: format, duration: "9.9" })), format).toMatchObject({
        ok: true,
        facts: { durationSeconds: 9.9, durationEstimated: true },
      });
    }
    for (const format of ["mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "ogg", "wav"]) {
      expect(voiceFactsFrom(probe([{ index: 0, codec_type: "audio", codec_name: "opus" }], { format_name: format, duration: "9.9" })), format).toMatchObject({
        facts: { durationEstimated: false },
      });
    }
  });

  it("refuses a recording with a moving picture, or with no sound, as unsupported-type, and nonsense as corrupt", () => {
    expect(
      voiceFactsFrom(
        probe([
          { index: 0, codec_type: "video", codec_name: "vp8" },
          { index: 1, codec_type: "audio", codec_name: "opus" },
        ]),
      ),
    ).toMatchObject({ ok: false, reason: "unsupported-type" });
    expect(voiceFactsFrom(probe([{ index: 0, codec_type: "subtitle", codec_name: "webvtt" }]))).toMatchObject({
      ok: false,
      reason: "unsupported-type",
    });
    expect(voiceFactsFrom(probe([]))).toMatchObject({ ok: false, reason: "unsupported-type" });
    expect(voiceFactsFrom({ nonsense: true })).toMatchObject({ ok: false, reason: "corrupt" });
  });
});

describe("voiceArgs and videoWishArgs: the ffmpeg notes' §2.4 and §2.5", () => {
  const paths = { original: "/scratch/job-1/original", output: "/scratch/job-1/wish.m4a" };

  it("makes a voice note AAC at 96 kbit/s in an M4A, trimmed to 60 s, its one sound stream and nothing else", () => {
    const args = voiceArgs(3, paths);
    const input = args.indexOf("-i");
    expect(args.slice(input - 2, input + 2)).toEqual(["-threads", "1", "-i", paths.original]);
    for (const flag of ["-hide_banner", "-nostdin", "-nostats", "-xerror", "-y"]) expect(args.indexOf(flag), flag).toBeLessThan(input);
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-format_whitelist") + 1]).toBe("mov,matroska,ogg,wav,mp3,aac,amr");
    expect(args.slice(input + 2)).toEqual([
      ...["-map", "0:3", "-vn", "-sn", "-dn"],
      ...["-map_metadata", "-1", "-map_chapters", "-1"],
      ...["-t", String(WISH_SECONDS.voice)],
      ...["-c:a", "aac", "-b:a", "96k"],
      ...["-movflags", "+faststart", "-f", "ipod", paths.output],
    ]);
  });

  it("makes a video message H.264 within 720p, at most 30 fps, trimmed to 30 s, from the decoder threads and x264's given", () => {
    const facts = {
      streamIndex: 0,
      audioStreamIndex: 1,
      hdr: null,
      sdr: { matrix: "bt709" as const, range: "tv" as const },
    };
    const args = videoWishArgs(facts, { original: "/o", output: "/v.mp4" }, { decoderThreads: 2, x264Threads: 3, filterThreads: 1, x264Preset: "veryfast" });
    const input = args.indexOf("-i");
    expect(args.slice(input - 2, input + 2)).toEqual(["-threads", "2", "-i", "/o"]);
    expect(args[args.indexOf("-filter_threads") + 1]).toBe("1");
    expect(args[args.indexOf("-format_whitelist") + 1]).toBe("mov,matroska");
    const after = args.slice(input + 2);
    expect(after.slice(0, 10)).toEqual(["-map", "0:0", "-map", "0:1", "-map_metadata", "-1", "-map_chapters", "-1", "-t", String(WISH_SECONDS.video)]);
    const filters = after[after.indexOf("-vf") + 1];
    // Orientation-aware: 1280 × 720 for landscape, 720 × 1280 for portrait (notes §4.11).
    expect(filters).toContain("scale=w='if(gte(iw,ih),min(1280,iw),min(720,iw))':h='if(gte(iw,ih),min(720,ih),min(1280,ih))'");
    expect(filters).toContain("setparams=color_primaries=bt709");
    expect(filters).toContain("sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA");
    expect(filters).not.toContain("tonemap");
    expect(after.slice(after.indexOf("-fpsmax"))).toEqual([
      ...["-fpsmax", "30"],
      ...["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-profile:v", "high", "-threads", "3"],
      ...["-c:a", "aac", "-b:a", "96k", "-ac", "2"],
      ...["-movflags", "+faststart", "-f", "mp4", "/v.mp4"],
    ]);
    expect(args).not.toContain("transpose");
    expect(args).not.toContain("-noautorotate");
  });

  it("tone-maps HLG and PQ to SDR BT.709, and leaves out the sound of a silent clip", () => {
    const facts = {
      streamIndex: 2,
      audioStreamIndex: null,
      hdr: { transfer: "arib-std-b67" as const, matrix: "bt2020nc" as const, primaries: "bt2020" as const, range: "tv" as const },
      sdr: { matrix: "bt709" as const, range: "tv" as const },
    };
    const args = videoWishArgs(facts, { original: "/o", output: "/v.mp4" }, { decoderThreads: 2, x264Threads: 2, filterThreads: 1, x264Preset: "veryfast" });
    const filters = args[args.indexOf("-vf") + 1];
    expect(filters).toContain("tonemap=tonemap=hable");
    expect(filters.indexOf("scale=w=")).toBeLessThan(filters.indexOf("zscale"));
    expect(args).not.toContain("-c:a");
    expect(args.filter((arg) => arg === "-map")).toHaveLength(1);
  });
});

describe("voiceProblem and videoWishProblem: what ffmpeg made is checked before it is published (notes §4.17)", () => {
  const voice = (duration: string, extra: Partial<Stream> = {}) => ({
    format: { duration, tags: { major_brand: "M4A " } },
    streams: [{ codec_type: "audio", codec_name: "aac", duration, ...extra }],
  });

  it("passes AAC in an M4A no longer than the limit (and a little AAC priming), as long as the original when that is shorter", () => {
    expect(voiceProblem(voice("60.007"), null)).toBeNull();
    expect(voiceProblem(voice("12.523"), 12.5)).toBeNull();
    expect(voiceProblem(voice("60.050"), 90)).toBeNull();
  });

  it("refuses anything longer, shorter than it should be, silent, or not AAC", () => {
    expect(voiceProblem(voice("60.2"), null)).toMatch(/60\.20 s/);
    expect(voiceProblem(voice("6.0"), 12.5)).toMatch(/6\.00 s/);
    expect(voiceProblem(voice("0"), null)).toMatch(/no length/);
    expect(voiceProblem({ format: { duration: "5" }, streams: [] }, null)).toMatch(/no AAC/);
    expect(voiceProblem(voice("5", { codec_name: "opus" }), null)).toMatch(/no AAC/);
    expect(voiceProblem({ ...voice("5"), streams: [...voice("5").streams, { codec_type: "video", codec_name: "png" }] }, null)).toMatch(/picture/);
    expect(voiceProblem({ ...voice("5"), format: { duration: "5", tags: { major_brand: "isom" } } }, null)).toMatch(/M4A/);
  });

  const video = (width: number, height: number, duration: string, extra: Partial<Stream> = {}) => ({
    format: { duration },
    streams: [
      {
        codec_type: "video",
        codec_name: "h264",
        profile: "High",
        pix_fmt: "yuv420p",
        width,
        height,
        duration,
        avg_frame_rate: "30/1",
        color_transfer: "bt709",
        ...extra,
      },
      { codec_type: "audio", codec_name: "aac", duration },
    ],
  });

  it("passes SDR H.264 High within 720p either way up, at most 30 fps, with its AAC, no longer than 30 s", () => {
    expect(videoWishProblem(video(720, 1280, "30.000"), { audio: true, originalSeconds: 81 })).toBeNull();
    expect(videoWishProblem(video(1280, 720, "3.0"), { audio: true, originalSeconds: null })).toBeNull();
  });

  it("refuses a picture past 720p, a turn left in it, HDR, too many frames, too long or too short, or lost sound", () => {
    expect(videoWishProblem(video(1080, 1920, "3"), { audio: true, originalSeconds: 3 })).toMatch(/1080 × 1920/);
    expect(videoWishProblem(video(721, 1280, "3"), { audio: true, originalSeconds: 3 })).toMatch(/721 × 1280/);
    expect(videoWishProblem(video(720, 1280, "3", { side_data_list: [{ rotation: -90 }] }), { audio: true, originalSeconds: 3 })).toMatch(/turn/);
    expect(videoWishProblem(video(720, 1280, "3", { color_transfer: "arib-std-b67" }), { audio: true, originalSeconds: 3 })).toMatch(/BT\.709/);
    expect(videoWishProblem(video(720, 1280, "3", { avg_frame_rate: "60/1" }), { audio: true, originalSeconds: 3 })).toMatch(/60 frames/);
    expect(videoWishProblem(video(720, 1280, "30.5"), { audio: true, originalSeconds: 81 })).toMatch(/30\.50 s/);
    expect(videoWishProblem(video(720, 1280, "1.2"), { audio: true, originalSeconds: 3 })).toMatch(/1\.20 s/);
    expect(videoWishProblem(video(720, 1280, "3", { profile: "High 10" }), { audio: true, originalSeconds: 3 })).toMatch(/High 10/);
    expect(videoWishProblem({ ...video(720, 1280, "3"), streams: video(720, 1280, "3").streams.slice(0, 1) }, { audio: true, originalSeconds: 3 })).toMatch(/no AAC/);
  });
});

describe.skipIf(!ffmpegSeven)("media.wish: a voice note (ffmpeg notes §2.4)", () => {
  it("makes a browser's WebM/Opus voice note an M4A, probed for its length, public under a content hash", async () => {
    const mediaId = await uploadedWish(await webmVoice(5), "audio", "webm");

    const report = await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.status).toBe("ready");
    expect(Object.keys(item.derived)).toEqual(["audio"]);
    expect(item.derived.audio).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/audio\\.m4a$`));
    expect(item.durationSeconds).toBeGreaterThan(4.9);
    expect(item.durationSeconds).toBeLessThan(5.1);
    expect(report).toEqual({ sizeBytes: item.sizeBytes, kind: "wish/voice-opus" });
    const published = await readPublic(item.derived.audio ?? "");
    expect(published.contentType).toBe("audio/mp4");
    expect(published.cacheControl).toBe("public, max-age=31536000, immutable");
    const description = await probeDescription(published.bytes, "m4a");
    expect(description.streams.map((stream) => [stream.codec_type, stream.codec_name])).toEqual([["audio", "aac"]]);
    expect(description.format.tags?.major_brand?.trim()).toBe("M4A");
    expect(topLevelBoxes(published.bytes).slice(0, 2)).toEqual(["ftyp", "moov"]);
    // A guest can reach it, through the public base URL.
    expect((await fetch(publicUrl(item.derived.audio ?? ""), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
  });

  it("trims a 90 s voice note to 60 s (about 0.1 s of AAC priming allowed)", async () => {
    const mediaId = await uploadedWish(await webmVoice(90), "audio", "webm");

    await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.durationSeconds).toBeGreaterThanOrEqual(59.9);
    expect(item.durationSeconds).toBeLessThanOrEqual(60.1);
    const description = await probeDescription((await readPublic(item.derived.audio ?? "")).bytes, "m4a");
    expect(Number(description.format.duration)).toBeLessThanOrEqual(60.1);
  });

  it("makes an iPhone's MP4/AAC voice note an M4A, with no location", async () => {
    const mediaId = await uploadedWish(await iphoneVoice(4), "audio", "m4a");

    const report = await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.status).toBe("ready");
    expect(item.durationSeconds).toBeCloseTo(4, 0);
    expect(report).toMatchObject({ kind: "wish/voice-aac" });
    const bytes = (await readPublic(item.derived.audio ?? "")).bytes;
    expect(locationsIn(bytes)).toEqual([]);
    expect((await probeDescription(bytes, "m4a")).format.tags ?? {}).not.toHaveProperty("location");
  });

  it("runs ffmpeg nice'd, under its memory and CPU caps, from the scratch file only", async () => {
    const mediaId = await uploadedWish(await webmVoice(3), "audio", "webm");

    await processWish(wishJob(mediaId), wishOptions());

    const conversion = programs.runs.find((run) => run.args.includes("ipod"));
    expect(conversion?.priority).toBe("background");
    expect(conversion?.args.slice(0, 1)).toEqual(["prlimit"]);
    expect(conversion?.args.some((arg) => arg.startsWith("--as="))).toBe(true);
    expect(conversion?.args.some((arg) => arg.startsWith("--cpu="))).toBe(true);
    expect(conversion?.args.filter((arg) => ANY_URL.test(arg))).toEqual([]);
  });

  it("refuses a voice wish that has a video stream, for good, as unsupported-type", async () => {
    const mediaId = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "audio", "webm");

    const error = await failureOf(processWish(wishJob(mediaId), wishOptions()));

    expect(error).toBeInstanceOf(PermanentJobError);
    expect((error as PermanentJobError).reason).toBe("unsupported-type");
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", derived: {} });
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });
});

describe.skipIf(!ffmpegSeven)("media.wish: a video message (ffmpeg notes §2.5)", () => {
  it("makes a browser's WebM VP8 video message H.264 within 720p, with a poster, every file public under one content hash", async () => {
    const mediaId = await uploadedWish(await webmVideo("libvpx"), "video", "webm");

    const report = await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.status).toBe("ready");
    expect(Object.keys(item.derived).sort()).toEqual(["poster-thumb", "poster-view", "video"]);
    const hashes = new Set(Object.values(item.derived).map((key) => key?.split("/")[2]));
    expect(hashes.size).toBe(1);
    expect(item.derived.video).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/video\\.mp4$`));
    expect({ width: item.width, height: item.height, videoCodec: item.videoCodec }).toEqual({ width: 640, height: 480, videoCodec: "vp8" });
    expect(item.durationSeconds).toBeCloseTo(3, 0);
    expect(item.thumbhash).toBeTruthy();
    expect(item.averageColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(report).toEqual({ sizeBytes: item.sizeBytes, kind: "wish/video-vp8" });

    const published = await readPublic(item.derived.video ?? "");
    expect(published.contentType).toBe("video/mp4");
    const description = await probeDescription(published.bytes);
    expect(videoOf(description)).toMatchObject({ codec_name: "h264", profile: "High", pix_fmt: "yuv420p", width: 640, height: 480 });
    expect(audioOf(description)).toMatchObject({ codec_name: "aac" });
    expect(topLevelBoxes(published.bytes).slice(0, 2)).toEqual(["ftyp", "moov"]);
    const poster = await readPublic(item.derived["poster-view"] ?? "");
    expect(poster.contentType).toBe("image/webp");
    expect(await sharp(poster.bytes).metadata()).toMatchObject({ format: "webp", width: 640, height: 480 });
  });

  it("makes a WebM VP9 one H.264 too", async () => {
    const mediaId = await uploadedWish(await webmVideo("libvpx-vp9", 2, "1280x720"), "video", "webm");

    await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.videoCodec).toBe("vp9");
    const description = await probeDescription((await readPublic(item.derived.video ?? "")).bytes);
    expect(videoOf(description)).toMatchObject({ codec_name: "h264", width: 1280, height: 720 });
  });

  it("makes an iPhone's portrait HLG clip upright SDR BT.709 within 720 × 1280, at most 30 fps, with no location", async () => {
    const mediaId = await uploadedWish(await iphoneVideo(), "video", "mov");

    const report = await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect({ width: item.width, height: item.height }).toEqual({ width: 720, height: 1280 });
    expect(report).toMatchObject({ kind: "wish/video-hevc-hdr" });
    const bytes = (await readPublic(item.derived.video ?? "")).bytes;
    const video = videoOf(await probeDescription(bytes));
    expect(video).toMatchObject({
      codec_name: "h264",
      pix_fmt: "yuv420p",
      width: 720,
      height: 1280,
      color_transfer: "bt709",
      color_primaries: "bt709",
      color_space: "bt709",
      avg_frame_rate: "30/1",
    });
    // Upright in its pixels: no display matrix, nor any HDR side data, left for a player to obey.
    expect(video.side_data_list ?? []).toEqual([]);
    expect(locationsIn(bytes)).toEqual([]);
    const poster = await sharp((await readPublic(item.derived["poster-view"] ?? "")).bytes).metadata();
    expect({ width: poster.width, height: poster.height }).toEqual({ width: 720, height: 1280 });
  });

  it("trims a video message to 30 s", async () => {
    const original = await recording("long.mp4", [
      ...["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=15", "-f", "lavfi", "-i", "sine=frequency=440"],
      ...["-t", "35", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-f", "mp4"],
    ]);
    const mediaId = await uploadedWish(original, "video", "mp4");

    await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.durationSeconds).toBeGreaterThan(29.5);
    expect(item.durationSeconds).toBeLessThanOrEqual(30.1);
  });

  it("runs the conversion nice'd, its decoder threads before -i and x264's after, from the settings", async () => {
    const mediaId = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "video", "webm");

    await processWish(wishJob(mediaId), wishOptions({ decoderThreads: 2, x264Threads: 3 }));

    const conversion = programs.runs.find((run) => run.args.includes("libx264"));
    expect(conversion?.priority).toBe("background");
    const args = conversion?.args ?? [];
    expect(args.slice(args.indexOf("-i") - 2, args.indexOf("-i"))).toEqual(["-threads", "2"]);
    expect(args[args.lastIndexOf("-threads") + 1]).toBe("3");
    expect(args.some((arg) => arg.startsWith("--cpu="))).toBe(true);
    // Its own time limit, with minutes to spare inside media.wish's expiry, so a stuck conversion
    // ends by ffmpeg's time-out, never by the job expiring around it.
    expect(conversion?.timeoutMilliseconds).toBe(VIDEO_WISH_MILLISECONDS);
    expect(VIDEO_WISH_MILLISECONDS).toBeLessThanOrEqual((MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.wish].expireInSeconds ?? 0) * 1000 - 5 * 60_000);
  });
});

describe.skipIf(!ffmpegSeven)("media.wish: once, and withdrawn with its wish", () => {
  it("publishes once however often it is delivered (Ruling AG), and does nothing for an album item or a recording not uploaded", async () => {
    const mediaId = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "video", "webm");
    await processWish(wishJob(mediaId), wishOptions());
    const { derived } = await readItem(mediaId);
    const putsAfterFirst = [...publishing.keys];
    const runsAfterFirst = programs.runs.length;
    expect([...putsAfterFirst].sort()).toEqual(Object.values(derived).sort());

    await processWish(wishJob(mediaId), wishOptions());
    await processWish(wishJob(mediaId, 3), wishOptions());

    expect(programs.runs).toHaveLength(runsAfterFirst);
    expect(publishing.keys).toEqual(putsAfterFirst);
    expect((await readItem(mediaId)).derived).toEqual(derived);

    programs.runs = [];
    const bytes = randomBytes(1024);
    for (const values of [
      { purpose: "album" as const },
      { status: "uploading" as const },
      { status: "failed" as const, failureReason: "corrupt" },
      { hiddenAt: new Date(), hiddenBy: ADMIN },
      { deletedAt: new Date() },
    ]) {
      const other = await uploadedWish(bytes, "video", "webm", values);
      await processWish(wishJob(other), wishOptions());
      expect(await readItem(other)).toMatchObject({ derived: {} });
    }
    expect(programs.runs).toEqual([]);
  });

  it("makes nothing of an orphan, a recording no wish names (Ruling CE): it never has a public file", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const orphan = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "video", "webm", {}, { linked: false });
    const deletedWish = await uploadedWish(await webmVoice(2), "audio", "webm");
    await getDb().update(wishes).set({ deletedAt: new Date(), signedAs: "deleted" }).where(eq(wishes.mediaId, deletedWish));

    for (const mediaId of [orphan, deletedWish]) {
      await processWish(wishJob(mediaId), wishOptions());
      expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", derived: {} });
      expect(await publicKeysOf(mediaId)).toEqual([]);
    }
    expect(programs.runs).toEqual([]);
    expect(publishing.keys).toEqual([]);

    // Named by a wish, it is made.
    await getDb().insert(wishes).values({ kind: "video", signedAs: "Ama Owusu", mediaId: orphan });
    await processWish(wishJob(orphan), wishOptions());
    expect(Object.keys((await readItem(orphan)).derived).sort()).toEqual(["poster-thumb", "poster-view", "video"]);
  });

  it("is withdrawn, every file, when its wish is hidden, and made again under new keys when it is unhidden", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "video", "webm");
    const wishId = await wishFor(mediaId);
    await processWish(wishJob(mediaId), wishOptions());
    const first = (await readItem(mediaId)).derived;
    expect(await publicKeysOf(mediaId)).toEqual(Object.values(first).sort());

    await hideWish(wishId, ADMIN);
    expect(await runQueued(MEDIA_QUEUES.visibility, mediaId, (job) => runVisibilityJob(job, visibilityOptions))).toBe(1);

    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(purgedUrls.sort()).toEqual(Object.values(first).map((key) => publicUrl(key ?? "")).sort());
    expect(await readItem(mediaId)).toMatchObject({ derived: {}, withdrawingKeys: null });
    // A wish job that arrives while it is hidden does nothing.
    await processWish(wishJob(mediaId), wishOptions());
    expect(await publicKeysOf(mediaId)).toEqual([]);

    await unhideWish(wishId, ADMIN);
    expect(await runQueued(MEDIA_QUEUES.wish, mediaId, (job) => processWish(job, wishOptions()))).toBe(1);

    const again = (await readItem(mediaId)).derived;
    expect(Object.keys(again).sort()).toEqual(["poster-thumb", "poster-view", "video"]);
    expect(again.video).not.toBe(first.video);
    expect(await publicKeysOf(mediaId)).toEqual(Object.values(again).sort());
    expect((await fetch(publicUrl(again.video ?? ""), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
  });

  it("withdraws a voice note's file with its wish too", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await uploadedWish(await webmVoice(2), "audio", "webm");
    const wishId = await wishFor(mediaId);
    await processWish(wishJob(mediaId), wishOptions());
    expect(await publicKeysOf(mediaId)).toHaveLength(1);

    await hideWish(wishId, ADMIN);
    await runQueued(MEDIA_QUEUES.visibility, mediaId, (job) => runVisibilityJob(job, visibilityOptions));

    expect(await publicKeysOf(mediaId)).toEqual([]);
    await unhideWish(wishId, ADMIN);
    await runQueued(MEDIA_QUEUES.wish, mediaId, (job) => processWish(job, wishOptions()));
    expect(await publicKeysOf(mediaId)).toHaveLength(1);
  });

  it("publishes nothing for a recording hidden while it was made: its files come down, recorded, and its withdrawal is queued", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const mediaId = await uploadedWish(await webmVideo("libvpx", 2, "320x240"), "video", "webm");
    publishing.afterPut = async () => {
      await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: ADMIN }).where(eq(media.id, mediaId));
    };

    await processWish(wishJob(mediaId), wishOptions());

    const item = await readItem(mediaId);
    expect(item.status).toBe("uploaded");
    expect(item.derived).toEqual({});
    expect(item.withdrawingKeys).toHaveLength(3);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    const withdrawals = await boss.findJobs(MEDIA_QUEUES.visibility, { data: { mediaId } });
    expect(withdrawals.map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });

  it("never puts a link in a job's error: a recording that isn't one, and a playlist pointing at a server", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const garbage = await uploadedWish(randomBytes(4096), "audio", "webm");
    const playlist = await uploadedWish(
      Buffer.from("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/secret.ts?X-Amz-Signature=abc123\n#EXT-X-ENDLIST\n"),
      "audio",
      "m4a",
    );
    const video = await uploadedWish(randomBytes(4096), "video", "mp4");

    for (const mediaId of [garbage, playlist, video]) {
      for (const retryCount of [0, 2]) {
        const error = await failureOf(processWish(wishJob(mediaId, retryCount), wishOptions()));
        expect(error.message, mediaId).not.toMatch(ANY_URL);
        expect(error.message).not.toContain("X-Amz");
      }
    }
    // A file that isn't a recording is refused for good by the third attempt.
    const lastAttempt = await failureOf(processWish(wishJob(garbage, 2), wishOptions()));
    expect(lastAttempt).toBeInstanceOf(PermanentJobError);
  });

  it("is what main.ts runs on media.wish", async () => {
    const mediaId = await uploadedWish(await webmVoice(2), "audio", "webm");
    await wishHandler(wishOptions())(wishJob(mediaId));
    expect((await readItem(mediaId)).status).toBe("ready");
  });
});
