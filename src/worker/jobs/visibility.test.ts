import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { deleteMediaPermanently, hideMedia, moveMedia, unhideMedia } from "@/lib/media/moderation";
import { isVisible } from "@/lib/media/rows";
import { storageClient } from "@/lib/storage/client";
import { derivedKey, manifestKey, originalKey, publicUrl } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import { workerConfig } from "../config";
import { PermanentJobError, type MediaJob } from "../queues";
import { prepareScratchRoot } from "../scratch";
import { processPhoto, type PhotoOptions } from "./photo";
import { runVisibilityJob, type VisibilityOptions } from "./visibility";

/*
 * media.visibility against the local MinIO and test database (docker compose up -d db minio && npm
 * run storage:init), with Cloudflare's purge_cache played by a local HTTP server.
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

// A test can act while a manifest's write is on its way, before it lands.
const manifests = vi.hoisted(() => ({ beforeNextWrite: null as null | (() => Promise<void>), failuresLeft: 0 }));
vi.mock("@/lib/storage/manifest", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/manifest")>();
  return {
    ...real,
    writeManifest: async (...args: Parameters<typeof real.writeManifest>) => {
      if (manifests.failuresLeft > 0) {
        manifests.failuresLeft -= 1;
        throw new Error("R2 answered 503 Slow Down");
      }
      const beforeWrite = manifests.beforeNextWrite;
      manifests.beforeNextWrite = null;
      await beforeWrite?.();
      return real.writeManifest(...args);
    },
  };
});

// A test can act just before the job lists the item's folder, or between its reading what to
// withdraw and its deleting it.
const deletes = vi.hoisted(() => ({
  beforeNext: null as null | (() => Promise<void>),
  beforeNextListing: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/storage/objects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/objects")>();
  return {
    ...real,
    listDerivedKeys: async (...args: Parameters<typeof real.listDerivedKeys>) => {
      const beforeListing = deletes.beforeNextListing;
      deletes.beforeNextListing = null;
      await beforeListing?.();
      return real.listDerivedKeys(...args);
    },
    deletePublicObjects: async (...args: Parameters<typeof real.deletePublicObjects>) => {
      const beforeDelete = deletes.beforeNext;
      deletes.beforeNext = null;
      await beforeDelete?.();
      return real.deletePublicObjects(...args);
    },
  };
});

const BOSS_SCHEMA = "pgboss_worker_visibility_test";
const ADMIN = "couple@example.com";
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const DAY = 24 * 60 * 60 * 1000;

type PurgeCall = { path: string; authorization: string | undefined; files: string[] };
const purge = {
  calls: [] as PurgeCall[],
  /** How many of the next calls Cloudflare refuses with a 500. */
  refuseNext: 0,
};

let boss: PgBoss;
let server: Server;
let folder: string;
let options: VisibilityOptions;
let photoOptions: PhotoOptions;
const privateKeys: string[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function answer(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
  folder = await mkdtemp(join(tmpdir(), "nona-visibility-test-"));
  await prepareScratchRoot(join(folder, "scratch"));
  server = createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { files: string[] };
    if (purge.refuseNext > 0) {
      purge.refuseNext -= 1;
      answer(response, 500, { success: false, errors: [{ code: 10001, message: "Internal error" }] });
      return;
    }
    purge.calls.push({ path: request.url ?? "", authorization: request.headers.authorization, files: body.files });
    answer(response, 200, { success: true, errors: [], result: { id: "purge" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/client/v4`;
  options = {
    purge: { apiUrl, env: { NODE_ENV: "production", CF_PURGE_TOKEN: "test-purge-token", CF_ZONE_ID: ZONE_ID } },
  };
  photoOptions = {
    heifMemoryBytes: workerConfig({}).heifMemoryBytes,
    heifThreads: workerConfig({}).threads.heif,
    jobQueue: async () => boss,
  };
});

afterAll(async () => {
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
  purge.calls = [];
  purge.refuseNext = 0;
  manifests.beforeNextWrite = null;
  manifests.failuresLeft = 0;
  deletes.beforeNext = null;
  deletes.beforeNextListing = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The public bucket's keys under an item's folder. */
async function publicKeysOf(mediaId: string): Promise<string[]> {
  const listing = await storageClient().send(
    new ListObjectsV2Command({ Bucket: storageConfig().publicBucket, Prefix: `derived/${mediaId}/` }),
  );
  return (listing.Contents ?? []).map((object) => object.Key ?? "").sort();
}

async function putPublic(key: string): Promise<void> {
  await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().publicBucket, Key: key, Body: "derived" }));
}

/** A photo uploaded and waiting for its processing: its original in the private bucket, its row `uploaded`. */
async function uploadedPhoto(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
  const key = originalKey(id, "png");
  privateKeys.push(key, manifestKey(id));
  const bytes = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#369" } }).png().toBuffer();
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
      originalFilename: "IMG_0001.PNG",
      sizeBytes: bytes.length,
      contentType: "image/png",
      status: "uploaded",
      startedAt: new Date("2026-12-05T20:00:00Z"),
      uploadedAt: new Date("2026-12-05T20:01:00Z"),
      ...values,
    });
  return id;
}

function jobFor(queueName: MediaQueueName, data: Record<string, unknown>, retryCount = 0): MediaJob {
  return {
    id: randomUUID(),
    queue: queueName as MediaJob["queue"],
    data,
    signal: AbortSignal.timeout(60_000),
    retryCount,
  };
}

/** A ready photo, processed by the photo job itself, with its two files in the public bucket. */
async function readyPhoto(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const mediaId = await uploadedPhoto(values);
  await processPhoto(jobFor(MEDIA_QUEUES.photo, { mediaId }), photoOptions);
  return mediaId;
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
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

const runVisibility = (job: MediaJob) => runVisibilityJob(job, options);
const runPhoto = (job: MediaJob) => processPhoto(job, photoOptions);

describe("hiding an item people have the links of (Review Focus 3)", () => {
  it("deletes its public files and purges exactly their URLs from Cloudflare, once the job runs", async () => {
    const mediaId = await readyPhoto();
    const keys = Object.values((await readItem(mediaId)).derived).sort();
    expect(keys).toHaveLength(2);
    expect(await publicKeysOf(mediaId)).toEqual(keys);

    await hideMedia(mediaId, { admin: ADMIN });
    expect(await isVisible(mediaId)).toBe(false);
    expect(await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility)).toBe(1);

    expect(await publicKeysOf(mediaId)).toEqual([]);
    for (const key of keys) expect((await fetch(publicUrl(key), { signal: AbortSignal.timeout(10_000) })).status).toBe(404);
    expect(purge.calls).toEqual([
      { path: `/client/v4/zones/${ZONE_ID}/purge_cache`, authorization: "Bearer test-purge-token", files: keys.map((key) => publicUrl(key)) },
    ]);
    expect(await readItem(mediaId)).toMatchObject({ derived: {}, status: "ready" });
    expect(await readManifest(mediaId)).toMatchObject({ hiddenBy: ADMIN });
  });

  it("withdraws a video's poster and converted file, and anything else under its folder the row doesn't name", async () => {
    const mediaId = randomUUID();
    const derived = {
      "poster-thumb": derivedKey(mediaId, "0123456789abcdef", "poster-thumb", "webp"),
      "poster-view": derivedKey(mediaId, "0123456789abcdef", "poster-view", "webp"),
      video: derivedKey(mediaId, "fedcba9876543210", "video", "mp4"),
    };
    // A conversion that finished after the hide put this up; its row never named it.
    const unnamed = derivedKey(mediaId, "1111222233334444", "video", "mp4");
    for (const key of [...Object.values(derived), unnamed]) await putPublic(key);
    await uploadedPhoto({ id: mediaId, kind: "video", status: "ready", listedAt: new Date(), conversion: "done", derived });
    await hideMedia(mediaId, { admin: ADMIN });

    await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility);

    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(purge.calls.flatMap((call) => call.files).sort()).toEqual(
      [...Object.values(derived), unnamed].map((key) => publicUrl(key)).sort(),
    );
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });

  it("withdraws an item its uploader removed the same way", async () => {
    const mediaId = await readyPhoto();
    const [row] = await getDb().select({ guestId: media.guestId }).from(media).where(eq(media.id, mediaId));
    expect(row.guestId).toBeNull();
    await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }).where(eq(media.id, mediaId));

    await runVisibility(jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" }));

    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(purge.calls).toHaveLength(1);
  });

  it("withdraws whatever is under the folder of an item whose row is gone", async () => {
    const mediaId = randomUUID();
    const key = derivedKey(mediaId, "0123456789abcdef", "thumb", "webp");
    await putPublic(key);

    await runVisibility(jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" }));

    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(purge.calls.flatMap((call) => call.files)).toEqual([publicUrl(key)]);
  });
});

describe("a purge that can't be made", () => {
  it("fails the job in production without CF_PURGE_TOKEN, to be retried, keeping the keys for the retry", async () => {
    const mediaId = await readyPhoto();
    const keys = Object.values((await readItem(mediaId)).derived).sort();
    await hideMedia(mediaId, { admin: ADMIN });
    const job = jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" });

    const failure = await runVisibilityJob(job, {
      purge: { ...options.purge, env: { NODE_ENV: "production", CF_ZONE_ID: ZONE_ID } },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentJobError);
    expect((failure as Error).message).toMatch(/CF_PURGE_TOKEN/);
    // The origin's copies are gone already; the cache's go on the retry, from the keys the row keeps.
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(Object.values((await readItem(mediaId)).derived).sort()).toEqual(keys);

    await runVisibilityJob({ ...job, retryCount: 1 }, options);
    expect(purge.calls.flatMap((call) => call.files)).toEqual(keys.map((key) => publicUrl(key)));
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });

  it("is retried when Cloudflare refuses, and purges on the retry", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });
    const job = jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" });
    purge.refuseNext = 1;

    await expect(runVisibility(job)).rejects.toThrow(/500/);
    await runVisibility({ ...job, retryCount: 1 });

    expect(purge.calls).toHaveLength(1);
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });

  it("skips the purge outside production when it isn't set up, and still deletes the files", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });

    await runVisibilityJob(jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" }), {
      purge: { ...options.purge, env: { NODE_ENV: "development" } },
    });

    expect(purge.calls).toEqual([]);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });
});

describe("a visibility job delivered twice, or after the item moved on (Ruling AG)", () => {
  it("does nothing the second time: nothing left to delete or purge", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });
    const job = jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" });

    await runVisibility(job);
    await runVisibility(job);

    expect(purge.calls).toHaveLength(1);
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });

  it("does nothing for an item unhidden before its turn", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });
    await unhideMedia(mediaId, ADMIN);
    await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto);
    const remade = (await readItem(mediaId)).derived;

    await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility);

    expect(purge.calls).toEqual([]);
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", derived: remade });
    for (const key of Object.values(remade)) expect(await publicKeysOf(mediaId)).toContain(key);
  });

  it("never deletes the files an unhide made again while it worked: they have keys of their own", async () => {
    const mediaId = await readyPhoto();
    const old = Object.values((await readItem(mediaId)).derived);
    await hideMedia(mediaId, { admin: ADMIN });
    // The job has read the row (hidden) and listed the folder; before it deletes, the item is
    // unhidden and processed again.
    deletes.beforeNext = async () => {
      await unhideMedia(mediaId, ADMIN);
      await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto);
    };
    await runVisibility(jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" }));

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", hiddenAt: null, derivedGeneration: 1 });
    const remade = Object.values(item.derived);
    expect(remade).toHaveLength(2);
    for (const key of remade) expect(old).not.toContain(key);
    expect(await publicKeysOf(mediaId)).toEqual([...remade].sort());
    expect(purge.calls.flatMap((call) => call.files).sort()).toEqual(old.map((key) => publicUrl(key)).sort());
  });

  it("lists the folder before it reads the row, so files an unhide made before the read are never taken for the hidden item's", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });
    // Unhidden and processed again just as the job starts: what it lists includes the new files,
    // but the row it reads afterwards says visible, so it withdraws nothing.
    deletes.beforeNextListing = async () => {
      await unhideMedia(mediaId, ADMIN);
      await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto);
    };

    await runVisibility(jobFor(MEDIA_QUEUES.visibility, { mediaId, action: "hide" }));

    const remade = Object.values((await readItem(mediaId)).derived);
    expect(remade).toHaveLength(2);
    for (const key of remade) expect(await publicKeysOf(mediaId)).toContain(key);
    expect(purge.calls).toEqual([]);
  });

  it("keeps the keys of files made after it read the row, when the item is hidden again meanwhile, for their own withdrawal", async () => {
    const mediaId = await readyPhoto();
    await hideMedia(mediaId, { admin: ADMIN });
    const [first] = await boss.findJobs<Record<string, unknown>>(MEDIA_QUEUES.visibility, { data: { mediaId } });
    await boss.deleteJob(MEDIA_QUEUES.visibility, first.id);
    deletes.beforeNext = async () => {
      await unhideMedia(mediaId, ADMIN);
      await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto);
      await hideMedia(mediaId, { admin: ADMIN });
    };

    await runVisibility(jobFor(MEDIA_QUEUES.visibility, first.data));

    // The second hide's files are still named: that hide's job (or the sweeper) withdraws them.
    const remade = Object.values((await readItem(mediaId)).derived);
    expect(remade).toHaveLength(2);
    expect(await publicKeysOf(mediaId)).toEqual([...remade].sort());
    expect(await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility)).toBe(1);
    expect(await publicKeysOf(mediaId)).toEqual([]);
    expect(await readItem(mediaId)).toMatchObject({ derived: {} });
  });

  it("fails for good on an action it doesn't know", async () => {
    await expect(runVisibility(jobFor(MEDIA_QUEUES.visibility, { mediaId: randomUUID(), action: "explode" }))).rejects.toBeInstanceOf(
      PermanentJobError,
    );
  });
});

describe("unhiding (Review Focus 3)", () => {
  it("restores the item: processed again into files under new keys, visible, in its place in the album", async () => {
    const mediaId = await readyPhoto();
    const before = await readItem(mediaId);
    await hideMedia(mediaId, { admin: ADMIN });
    await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility);

    await unhideMedia(mediaId, ADMIN);
    expect(await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto)).toBe(1);

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ status: "ready", hiddenAt: null, listedAt: before.listedAt, thumbhash: before.thumbhash });
    expect(await isVisible(mediaId)).toBe(true);
    const keys = Object.values(item.derived).sort();
    expect(keys).toHaveLength(2);
    expect(await publicKeysOf(mediaId)).toEqual(keys);
    for (const key of Object.values(before.derived)) expect(keys).not.toContain(key);
    for (const key of keys) expect((await fetch(publicUrl(key), { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenAt: null, hiddenBy: null });
  });
});

describe("a move (the couple's celebration) survives processing", () => {
  it("is kept when the photo is processed after it, and again after a hide and an unhide", async () => {
    const mediaId = await uploadedPhoto({ capturedAt: new Date("2026-12-05T20:00:00Z") });
    await moveMedia(mediaId, "thanks", ADMIN);

    await processPhoto(jobFor(MEDIA_QUEUES.photo, { mediaId }), photoOptions);
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", celebration: "thanks", celebrationSetByAdmin: true });

    await hideMedia(mediaId, { admin: ADMIN });
    await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility);
    await unhideMedia(mediaId, ADMIN);
    await runQueued(MEDIA_QUEUES.photo, mediaId, runPhoto);

    expect(await readItem(mediaId)).toMatchObject({ status: "ready", celebration: "thanks", celebrationSetByAdmin: true });
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true, hiddenAt: null });
  });
});

describe("the manifest, when a processing job and a hide write it at once", () => {
  it("ends hidden though the processing job's write, its facts read before the hide, lands last", async () => {
    const mediaId = await uploadedPhoto();
    manifests.beforeNextWrite = async () => {
      // The photo is ready and its job's manifest write is on its way; the couple hide it meanwhile.
      await hideMedia(mediaId, { admin: ADMIN });
    };

    await processPhoto(jobFor(MEDIA_QUEUES.photo, { mediaId }), photoOptions);

    expect(await readManifest(mediaId)).toMatchObject({ hiddenBy: ADMIN, hiddenAt: (await readItem(mediaId)).hiddenAt });
  });

  it("is written by the sync action from the row as it is now", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await readyPhoto();
    manifests.failuresLeft = 10;
    await moveMedia(mediaId, "ceremony", ADMIN);
    manifests.failuresLeft = 0;

    expect(await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility)).toBe(1);

    expect(await readManifest(mediaId)).toMatchObject({ celebration: "ceremony", celebrationSetByAdmin: true });
    expect(purge.calls).toEqual([]);
  });
});

describe("deleting permanently", () => {
  it("leaves the job to purge the deleted item's URLs, then clears the tombstone's keys", async () => {
    const mediaId = await readyPhoto({ uploadedAt: new Date(Date.now() - 31 * DAY) });
    const keys = Object.values((await readItem(mediaId)).derived).sort();

    expect(await deleteMediaPermanently(mediaId, ADMIN)).toEqual({ ok: true });
    await runQueued(MEDIA_QUEUES.visibility, mediaId, runVisibility);

    expect(purge.calls.flatMap((call) => call.files)).toEqual(keys.map((key) => publicUrl(key)));
    expect(await readItem(mediaId)).toMatchObject({ derived: {}, thumbhash: null });
    expect(await readManifest(mediaId)).toBeNull();
    expect(await publicKeysOf(mediaId)).toEqual([]);
  });
});
