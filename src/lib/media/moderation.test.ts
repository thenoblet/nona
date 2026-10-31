import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DeleteObjectsCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getSetting, setSetting } from "@/lib/data/settings";
import { addWish, listWishes } from "@/lib/data/wishes";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { CONVERT_PRIORITY, MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { derivedKey, manifestKey, originalKey } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { headOriginal } from "@/lib/storage/objects";
import { resetDb } from "../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../test/uploads";
import {
  deleteMediaPermanently,
  deleteWishPermanently,
  hideMedia,
  hideWish,
  moveMedia,
  retryProcessing,
  setHighlight,
  unhideMedia,
  unhideWish,
} from "../../../test/moderation";
import { syncManifest } from "./manifest-sync";
import * as moderation from "./moderation";
import { ALBUM_SLIDES_TAG, deletableFrom, setConvertBacklog, setUploadsOpen } from "./moderation";
import { findPlayableVideo, findUpload, isVisible } from "./rows";
import { isVisibleUpload, readUploadsSwitch } from "./uploads";

// These run against the local MinIO and test database: docker compose up -d db minio && npm run storage:init.

// The app's job queue, played by a real pg-boss in a schema of its own; `sendFails` makes every
// send throw, as a queue that is down would.
const queue = vi.hoisted(() => ({ boss: null as unknown, sendFails: false }));
vi.mock("@/lib/jobs/boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/boss")>();
  return {
    ...real,
    getBoss: async () => {
      if (queue.sendFails) {
        return {
          send: async () => {
            throw Object.assign(new Error("The job queue is down"), { code: "57P01" });
          },
        };
      }
      if (!queue.boss) throw new Error("The test queue isn't started");
      return queue.boss;
    },
  };
});

// A test can make the manifest's writes fail, as R2 might, or act while one is on its way.
const manifests = vi.hoisted(() => ({
  failuresLeft: 0,
  writes: [] as { mediaId: string; hidden: boolean }[],
  beforeNextWrite: null as null | (() => Promise<void>),
}));
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
      manifests.writes.push({ mediaId: args[0], hidden: args[1].hiddenAt !== null });
      return real.writeManifest(...args);
    },
  };
});

// A test can make deleting an original fail, as R2 (or its bucket lock) might.
const originals = vi.hoisted(() => ({ deleteFails: false }));
vi.mock("@/lib/storage/objects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/objects")>();
  return {
    ...real,
    deleteOriginal: async (...args: Parameters<typeof real.deleteOriginal>) => {
      if (originals.deleteFails) throw Object.assign(new Error("Access Denied: the object is locked"), { name: "AccessDenied" });
      return real.deleteOriginal(...args);
    },
  };
});

const BOSS_SCHEMA = "pgboss_moderation_test";
const ADMIN = "couple@example.com";
const DAY = 24 * 60 * 60 * 1000;
let boss: PgBoss;
const privateKeys: string[] = [];
const publicKeys: string[] = [];

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
  const { privateBucket, publicBucket } = storageConfig();
  for (const [bucket, keys] of [
    [privateBucket, privateKeys],
    [publicBucket, publicKeys],
  ] as const) {
    for (let start = 0; start < keys.length; start += 1000) {
      const batch = keys.slice(start, start + 1000);
      await storageClient().send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true } }),
      );
    }
  }
});

beforeEach(async () => {
  await resetDb();
  for (const name of Object.values(MEDIA_QUEUES)) await boss.deleteAllJobs(name);
  queue.sendFails = false;
  manifests.failuresLeft = 0;
  manifests.writes = [];
  manifests.beforeNextWrite = null;
  originals.deleteFails = false;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function putObject(bucket: string, key: string, body: Uint8Array | string): Promise<void> {
  await storageClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await storageClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error instanceof Error && (error.name === "NotFound" || error.name === "NoSuchKey")) return false;
    throw error;
  }
}

/**
 * An album item as the worker leaves one: its original in the private bucket, and when `ready`, its
 * derived files in the public one and its manifest. A photo unless `values` say otherwise.
 */
async function addItem(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
  const key = originalKey(id, "jpg");
  const status = values.status ?? "ready";
  const kind = values.kind ?? "photo";
  const derived: Record<string, string> = {};
  if (status === "ready") {
    const variants = kind === "video" ? (["poster-thumb", "poster-view"] as const) : (["thumb", "view"] as const);
    for (const variant of variants) derived[variant] = derivedKey(id, "0123456789abcdef", variant, "webp");
    if (values.conversion === "done") derived.video = derivedKey(id, "fedcba9876543210", "video", "mp4");
  }
  privateKeys.push(key, manifestKey(id));
  publicKeys.push(...Object.values(derived));
  const { privateBucket, publicBucket } = storageConfig();
  await putObject(privateBucket, key, randomBytes(64));
  for (const derivedFile of Object.values(derived)) await putObject(publicBucket, derivedFile, randomBytes(32));
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind,
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "reception",
      originalKey: key,
      originalFilename: "IMG_0001.JPG",
      sizeBytes: 64,
      contentType: kind === "video" ? "video/quicktime" : "image/jpeg",
      status,
      startedAt: new Date(Date.now() - 2 * DAY),
      uploadedAt: status === "uploading" ? null : new Date(Date.now() - 2 * DAY),
      listedAt: status === "ready" ? new Date(Date.now() - DAY) : null,
      derived,
      thumbhash: status === "ready" ? "AAAA" : null,
      averageColor: status === "ready" ? "#336699" : null,
      ...values,
    });
  return id;
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

/** The jobs sent to this queue for this item, oldest first. */
async function jobsOf(queueName: MediaQueueName, mediaId: string) {
  const jobs = await boss.findJobs<Record<string, unknown>>(queueName, { data: { mediaId } });
  return jobs.sort((first, second) => first.createdOn.getTime() - second.createdOn.getTime());
}

async function addGuest(name = "Ama Owusu"): Promise<string> {
  return (await createGuest(name)).id;
}

describe("what the actions log (Ruling AT)", () => {
  it("is ids only: never the admin's email, and refuses an action with no admin", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const photo = await addItem({ uploadedAt: new Date(Date.now() - 31 * DAY) });
    const video = await addItem({ kind: "video", conversion: "failed", conversionFailureReason: "corrupt" });
    const wish = await addWish({ kind: "text", message: "Hello", signedAs: "Ama" });
    queue.sendFails = true;

    await hideMedia(photo, { admin: ADMIN });
    await unhideMedia(photo, ADMIN);
    await moveMedia(photo, "thanks", ADMIN);
    await setHighlight(video, true, ADMIN);
    await retryProcessing(video, ADMIN);
    await deleteMediaPermanently(photo, ADMIN);
    await hideWish(wish.id, ADMIN);
    await unhideWish(wish.id, ADMIN);
    await deleteWishPermanently(wish.id, ADMIN);
    await setUploadsOpen(true, ADMIN);
    await setUploadsOpen(false, ADMIN);
    await setConvertBacklog(false, ADMIN);

    const logged = [...logs.mock.calls, ...errors.mock.calls].flat().map(String).join("\n");
    expect(logged).toContain(photo);
    expect(logged).not.toContain(ADMIN);
    expect(logged).not.toContain("couple@");

    for (const admin of ["", "  "]) {
      await expect(hideMedia(photo, { admin })).rejects.toThrow(/admin/);
      await expect(setUploadsOpen(true, admin)).rejects.toThrow(/admin/);
    }
  });
});

describe("ALBUM_SLIDES_TAG", () => {
  it("is the album's and the slideshow's cache tag, which callers invalidate in their own context (Ruling A)", () => {
    expect(ALBUM_SLIDES_TAG).toBe("album-slides");
  });
});

describe("moderation.ts's imports", () => {
  it("reach no next/ module, so the media worker can bundle it and its callers invalidate the caches", async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./moderation.ts", import.meta.url))],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      packages: "external",
      tsconfig: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
      logLevel: "silent",
    });
    const modules = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((imported) => imported.path));
    expect(modules.filter((path) => path === "next" || path.startsWith("next/"))).toEqual([]);
  });
});

describe("hideMedia by an admin (Review Focus 3)", () => {
  it("takes the item out of every visibility check at once, records the hide, writes the manifest and queues its withdrawal", async () => {
    const mediaId = await addItem();

    expect(await hideMedia(mediaId, { admin: ADMIN })).toEqual({ ok: true });

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ hiddenBy: ADMIN, removedByUploader: false, status: "ready" });
    expect(item.hiddenAt).toBeInstanceOf(Date);
    expect(await isVisible(mediaId)).toBe(false);
    const upload = await findUpload(mediaId);
    expect(upload && isVisibleUpload(upload)).toBe(false);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenAt: item.hiddenAt, hiddenBy: ADMIN, removedByUploader: false });
    expect((await jobsOf(MEDIA_QUEUES.visibility, mediaId)).map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });

  it("leaves a hidden video out of the playable lookup the playable route answers from", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "queued" });
    expect(await findPlayableVideo(mediaId)).not.toBeNull();

    await hideMedia(mediaId, { admin: ADMIN });

    expect(await findPlayableVideo(mediaId)).toBeNull();
  });

  it("keeps the first hide's time and author when hidden again (Ruling AG), and queues the withdrawal again harmlessly", async () => {
    const mediaId = await addItem();
    await hideMedia(mediaId, { admin: ADMIN });
    const first = await readItem(mediaId);

    expect(await hideMedia(mediaId, { admin: "other@example.com" })).toEqual({ ok: true });

    const second = await readItem(mediaId);
    expect(second.hiddenAt).toEqual(first.hiddenAt);
    expect(second.hiddenBy).toBe(ADMIN);
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(2);
  });

  it("still hides the item when the queue is down: the sweeper sends the withdrawal from the row", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem();
    queue.sendFails = true;

    expect(await hideMedia(mediaId, { admin: ADMIN })).toEqual({ ok: true });

    expect(await isVisible(mediaId)).toBe(false);
    expect(errors.mock.calls.flat().join(" ")).toContain(mediaId);
  });

  it("still hides the item when R2 refuses the manifest: the visibility job writes it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem();
    manifests.failuresLeft = 10;

    expect(await hideMedia(mediaId, { admin: ADMIN })).toEqual({ ok: true });

    expect(await isVisible(mediaId)).toBe(false);
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(1);
    expect(errors.mock.calls.flat().join(" ")).toContain(mediaId);
  });

  it("leaves its manifest and job to after the response when the caller defers them (a route's after())", async () => {
    const mediaId = await addItem();
    await syncManifest(mediaId);
    const deferred: (() => Promise<void>)[] = [];

    expect(await moderation.hideMedia(mediaId, { admin: ADMIN }, { defer: (task) => deferred.push(task) })).toEqual({ ok: true });

    // Hidden at once; the rest waits for the response.
    expect(await isVisible(mediaId)).toBe(false);
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toEqual([]);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenAt: null });

    await Promise.all(deferred.map((task) => task()));

    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(1);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenBy: ADMIN });
  });

  it("finds nothing to hide for an unknown id, one that isn't a UUID, or a deleted item", async () => {
    const deleted = await addItem({ deletedAt: new Date() });
    for (const mediaId of [randomUUID(), "not-a-uuid", deleted]) {
      expect(await hideMedia(mediaId, { admin: ADMIN }), mediaId).toEqual({ ok: false, reason: "not-found" });
    }
    expect(await jobsOf(MEDIA_QUEUES.visibility, deleted)).toEqual([]);
  });
});

describe("hideMedia by its uploader: Remove my upload (Ruling Y)", () => {
  it("hides the guest's own item and marks it removed by its uploader, as the database requires together", async () => {
    const guestId = await addGuest();
    const mediaId = await addItem({ guestId });

    expect(await hideMedia(mediaId, { guestIds: [guestId] })).toEqual({ ok: true });

    const item = await readItem(mediaId);
    expect(item).toMatchObject({ removedByUploader: true, hiddenBy: "guest" });
    expect(item.hiddenAt).toBeInstanceOf(Date);
    expect(await isVisible(mediaId)).toBe(false);
    expect(await readManifest(mediaId)).toMatchObject({ removedByUploader: true });
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(1);
  });

  it("lets a browser remove an item of any guest it holds (its own, or one opened through a personal link)", async () => {
    const own = await addGuest();
    const remembered = await addGuest("Kofi Mensah");
    const mediaId = await addItem({ guestId: remembered });

    expect(await hideMedia(mediaId, { guestIds: [own, remembered] })).toEqual({ ok: true });
    expect(await readItem(mediaId)).toMatchObject({ removedByUploader: true });
  });

  it("refuses another guest's item, and an item no guest uploaded, leaving it as it was", async () => {
    const owner = await addGuest();
    const stranger = await addGuest("Kofi Mensah");
    const theirs = await addItem({ guestId: owner });
    const nobodys = await addItem();

    for (const [mediaId, guestIds] of [
      [theirs, [stranger]],
      [theirs, []],
      [theirs, ["not-a-uuid"]],
      [nobodys, [stranger]],
    ] as const) {
      const before = await readItem(mediaId);
      expect(await hideMedia(mediaId, { guestIds: [...guestIds] }), `${mediaId} ${guestIds}`).toEqual({
        ok: false,
        reason: "not-owner",
      });
      expect(await readItem(mediaId)).toEqual(before);
    }
    expect(await jobsOf(MEDIA_QUEUES.visibility, theirs)).toEqual([]);
  });

  it("answers not-found for no such item, whoever asks", async () => {
    const guestId = await addGuest();
    expect(await hideMedia(randomUUID(), { guestIds: [guestId] })).toEqual({ ok: false, reason: "not-found" });
  });

  it("leaves an item the couple had already hidden as theirs: its guest's removal succeeds and changes nothing", async () => {
    const guestId = await addGuest();
    const mediaId = await addItem({ guestId });
    await hideMedia(mediaId, { admin: ADMIN });
    const hidden = await readItem(mediaId);

    // Marked removed, the item would read as the guest's own doing, which a re-upload may undo (Ruling AX).
    expect(await hideMedia(mediaId, { guestIds: [guestId] })).toEqual({ ok: true });

    expect(await readItem(mediaId)).toMatchObject({ hiddenAt: hidden.hiddenAt, hiddenBy: ADMIN, removedByUploader: false });
  });
});

describe("unhideMedia", () => {
  it("makes a ready item visible and processed again: back to uploaded, a new generation of files, its job queued", async () => {
    const mediaId = await addItem({ guestId: await addGuest() });
    await hideMedia(mediaId, { admin: ADMIN });
    const listedAt = (await readItem(mediaId)).listedAt;

    expect(await unhideMedia(mediaId, ADMIN)).toEqual({ ok: true });

    const item = await readItem(mediaId);
    expect(item).toMatchObject({
      hiddenAt: null,
      hiddenBy: null,
      removedByUploader: false,
      status: "uploaded",
      derived: {},
      derivedGeneration: 1,
      listedAt,
    });
    expect(await isVisible(mediaId)).toBe(true);
    expect((await jobsOf(MEDIA_QUEUES.photo, mediaId)).map((job) => job.data)).toEqual([{ mediaId }]);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenAt: null, hiddenBy: null, removedByUploader: false });
  });

  it("brings back an item its uploader removed", async () => {
    const guestId = await addGuest();
    const mediaId = await addItem({ guestId });
    await hideMedia(mediaId, { guestIds: [guestId] });

    await unhideMedia(mediaId, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ hiddenAt: null, removedByUploader: false });
  });

  it("puts a video's finished or interrupted conversion back to queued, unleased, for its poster's ready mark to send", async () => {
    for (const conversion of ["done", "converting", "queued"] as const) {
      const mediaId = await addItem({ kind: "video", conversion, conversionJobId: conversion === "converting" ? randomUUID() : null });
      await hideMedia(mediaId, { admin: ADMIN });

      await unhideMedia(mediaId, ADMIN);

      expect(await readItem(mediaId), conversion).toMatchObject({
        status: "uploaded",
        conversion: "queued",
        conversionJobId: null,
        derived: {},
      });
      expect(await jobsOf(MEDIA_QUEUES.poster, mediaId), conversion).toHaveLength(1);
    }
  });

  it("leaves a failed conversion failed: its retry is the admin's to ask", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "failed", conversionFailureReason: "too-long" });
    await hideMedia(mediaId, { admin: ADMIN });

    await unhideMedia(mediaId, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ conversion: "failed", conversionFailureReason: "too-long" });
  });

  it("queues the processing of an item hidden before it was ever processed", async () => {
    const mediaId = await addItem({ status: "uploaded" });
    await hideMedia(mediaId, { admin: ADMIN });

    await unhideMedia(mediaId, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", hiddenAt: null });
    expect(await jobsOf(MEDIA_QUEUES.photo, mediaId)).toHaveLength(1);
  });

  it("leaves a failed item failed, and queues nothing", async () => {
    const mediaId = await addItem({ status: "failed", failureReason: "corrupt" });
    await hideMedia(mediaId, { admin: ADMIN });

    await unhideMedia(mediaId, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ status: "failed", failureReason: "corrupt", hiddenAt: null });
    expect(await jobsOf(MEDIA_QUEUES.photo, mediaId)).toEqual([]);
  });

  it("does nothing more when the item is visible already (Ruling AG): one new generation, one job", async () => {
    const mediaId = await addItem();
    await hideMedia(mediaId, { admin: ADMIN });

    expect(await unhideMedia(mediaId, ADMIN)).toEqual({ ok: true });
    expect(await unhideMedia(mediaId, ADMIN)).toEqual({ ok: true });

    expect(await readItem(mediaId)).toMatchObject({ derivedGeneration: 1 });
    expect(await jobsOf(MEDIA_QUEUES.photo, mediaId)).toHaveLength(1);
  });

  it("unhides even when the queue is down: the sweeper queues the processing of an uploaded item", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem();
    await hideMedia(mediaId, { admin: ADMIN });
    queue.sendFails = true;

    expect(await unhideMedia(mediaId, ADMIN)).toEqual({ ok: true });
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", hiddenAt: null });
  });

  it("asks the visibility job to write the manifest when R2 refuses it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem();
    await hideMedia(mediaId, { admin: ADMIN });
    manifests.failuresLeft = 10;

    expect(await unhideMedia(mediaId, ADMIN)).toEqual({ ok: true });

    const sent = (await jobsOf(MEDIA_QUEUES.visibility, mediaId)).map((job) => job.data);
    expect(sent).toHaveLength(2);
    expect(sent).toEqual(expect.arrayContaining([{ mediaId, action: "hide" }, { mediaId, action: "sync" }]));
  });

  it("finds nothing for an unknown or deleted item", async () => {
    const deleted = await addItem({ hiddenAt: new Date(), hiddenBy: ADMIN, deletedAt: new Date() });
    for (const mediaId of [randomUUID(), "not-a-uuid", deleted]) {
      expect(await unhideMedia(mediaId, ADMIN), mediaId).toEqual({ ok: false, reason: "not-found" });
    }
  });
});

describe("moveMedia", () => {
  it("moves the item to the couple's choice, marks it theirs, and writes the manifest", async () => {
    const mediaId = await addItem({ celebration: "reception" });

    expect(await moveMedia(mediaId, "thanks", ADMIN)).toEqual({ ok: true });

    expect(await readItem(mediaId)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
  });

  it("moves an item still waiting to be processed, and to More moments", async () => {
    const mediaId = await addItem({ status: "uploaded" });

    await moveMedia(mediaId, "more", ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ celebration: "more", celebrationSetByAdmin: true });
  });

  it("is the same done twice (Ruling AG)", async () => {
    const mediaId = await addItem();
    await moveMedia(mediaId, "ceremony", ADMIN);
    await moveMedia(mediaId, "ceremony", ADMIN);
    expect(await readItem(mediaId)).toMatchObject({ celebration: "ceremony", celebrationSetByAdmin: true });
  });

  it("refuses a celebration that doesn't exist, and finds nothing for an unknown or deleted item", async () => {
    const mediaId = await addItem();
    await expect(moveMedia(mediaId, "honeymoon" as never, ADMIN)).rejects.toThrow(/honeymoon/);
    expect(await readItem(mediaId)).toMatchObject({ celebration: "reception", celebrationSetByAdmin: false });
    const deleted = await addItem({ deletedAt: new Date() });
    for (const missing of [randomUUID(), deleted]) {
      expect(await moveMedia(missing, "thanks", ADMIN)).toEqual({ ok: false, reason: "not-found" });
    }
  });

  it("sends the manifest to the visibility job when R2 refuses it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem();
    manifests.failuresLeft = 10;

    expect(await moveMedia(mediaId, "thanks", ADMIN)).toEqual({ ok: true });

    expect((await jobsOf(MEDIA_QUEUES.visibility, mediaId)).map((job) => job.data)).toEqual([{ mediaId, action: "sync" }]);
  });
});

describe("setHighlight", () => {
  it("marks a ready video a highlight and sends its queued conversion at priority 20", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "queued" });

    expect(await setHighlight(mediaId, true, ADMIN)).toEqual({ ok: true });

    expect(await readItem(mediaId)).toMatchObject({ highlight: true });
    const jobs = await jobsOf(MEDIA_QUEUES.convert, mediaId);
    expect(jobs.map((job) => ({ data: job.data, priority: job.priority }))).toEqual([
      { data: { mediaId }, priority: CONVERT_PRIORITY.onDemand },
    ]);
  });

  it("sends nothing for a video with no conversion waiting: none needed, done, converting or failed, or hidden", async () => {
    for (const values of [
      { conversion: "none" },
      { conversion: "done" },
      { conversion: "converting", conversionJobId: randomUUID() },
      { conversion: "failed" },
      { conversion: "queued", hiddenAt: new Date(), hiddenBy: ADMIN },
    ] as const) {
      const mediaId = await addItem({ kind: "video", ...values });
      expect(await setHighlight(mediaId, true, ADMIN)).toEqual({ ok: true });
      expect(await readItem(mediaId), JSON.stringify(values)).toMatchObject({ highlight: true });
      expect(await jobsOf(MEDIA_QUEUES.convert, mediaId), JSON.stringify(values)).toEqual([]);
    }
  });

  it("turns a highlight off, sending nothing", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "queued", highlight: true });

    await setHighlight(mediaId, false, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({ highlight: false });
    expect(await jobsOf(MEDIA_QUEUES.convert, mediaId)).toEqual([]);
  });

  it("marks the highlight though the queue is down: the sweeper sends an on-demand job for it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem({ kind: "video", conversion: "queued" });
    queue.sendFails = true;

    expect(await setHighlight(mediaId, true, ADMIN)).toEqual({ ok: true });
    expect(await readItem(mediaId)).toMatchObject({ highlight: true, conversion: "queued" });
  });

  it("is harmless twice (Ruling AG), and finds nothing for an unknown item", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "queued" });
    await setHighlight(mediaId, true, ADMIN);
    await setHighlight(mediaId, true, ADMIN);
    expect(await readItem(mediaId)).toMatchObject({ highlight: true, conversion: "queued" });
    expect(await setHighlight(randomUUID(), true, ADMIN)).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("retryProcessing", () => {
  it("re-queues a failed photo's or video's processing on its own queue", async () => {
    const photo = await addItem({ status: "failed", failureReason: "processing-failed" });
    const video = await addItem({ status: "failed", failureReason: "corrupt", kind: "video" });

    expect(await retryProcessing(photo, ADMIN)).toEqual({ ok: true, retried: "processing" });
    expect(await retryProcessing(video, ADMIN)).toEqual({ ok: true, retried: "processing" });

    expect(await readItem(photo)).toMatchObject({ status: "uploaded", failureReason: null });
    expect(await readItem(video)).toMatchObject({ status: "uploaded", failureReason: null });
    expect(await jobsOf(MEDIA_QUEUES.photo, photo)).toHaveLength(1);
    expect(await jobsOf(MEDIA_QUEUES.poster, video)).toHaveLength(1);
  });

  it("re-queues a failed conversion at priority 20, marked on demand: its reason and lease cleared (Ruling AT)", async () => {
    const ordinary = await addItem({
      kind: "video",
      conversion: "failed",
      conversionFailureReason: "processing-failed",
      conversionJobId: randomUUID(),
    });
    const askedAt = new Date("2026-12-06T10:00:00Z");
    const asked = await addItem({ kind: "video", conversion: "failed", conversionFailureReason: "corrupt", conversionRequestedAt: askedAt });
    const before = Date.now();

    expect(await retryProcessing(ordinary, ADMIN)).toEqual({ ok: true, retried: "conversion" });
    expect(await retryProcessing(asked, ADMIN)).toEqual({ ok: true, retried: "conversion" });

    const retried = await readItem(ordinary);
    expect(retried).toMatchObject({ conversion: "queued", conversionFailureReason: null, conversionJobId: null });
    // On demand, so a send that fails is sent at 20 by the sweeper too, never to a held backlog.
    expect(retried.conversionRequestedAt?.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect((await readItem(asked)).conversionRequestedAt).toEqual(askedAt);
    for (const mediaId of [ordinary, asked]) {
      expect((await jobsOf(MEDIA_QUEUES.convert, mediaId)).map((job) => job.priority), mediaId).toEqual([CONVERT_PRIORITY.onDemand]);
    }
  });

  it("finds nothing to retry the second time (Ruling AG), nor for a ready item, and nothing for an unknown one", async () => {
    const failed = await addItem({ status: "failed", failureReason: "corrupt" });
    await retryProcessing(failed, ADMIN);

    expect(await retryProcessing(failed, ADMIN)).toEqual({ ok: false, reason: "nothing-to-retry" });
    expect(await retryProcessing(await addItem(), ADMIN)).toEqual({ ok: false, reason: "nothing-to-retry" });
    expect(await retryProcessing(randomUUID(), ADMIN)).toEqual({ ok: false, reason: "not-found" });
    expect(await jobsOf(MEDIA_QUEUES.photo, failed)).toHaveLength(1);
  });

  it("re-queues though the queue is down: the sweeper sends an uploaded item's job", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem({ status: "failed", failureReason: "corrupt" });
    queue.sendFails = true;

    expect(await retryProcessing(mediaId, ADMIN)).toEqual({ ok: true, retried: "processing" });
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded" });
  });
});

describe("deleteMediaPermanently", () => {
  it("is allowed only from 30 days and an hour after the upload, the originals' lock, and says from when", () => {
    const uploadedAt = new Date("2026-12-05T15:00:00Z");
    expect(deletableFrom(uploadedAt)).toEqual(new Date("2027-01-04T16:00:00Z"));
  });

  it("refuses an early delete with its allowedFrom date, and changes nothing", async () => {
    const uploadedAt = new Date(Date.now() - 29 * DAY);
    const mediaId = await addItem({ uploadedAt });
    const before = await readItem(mediaId);

    expect(await deleteMediaPermanently(mediaId, ADMIN)).toEqual({
      ok: false,
      reason: "locked",
      allowedFrom: deletableFrom(uploadedAt),
    });

    expect(await readItem(mediaId)).toEqual(before);
    expect(await headOriginal(before.originalKey)).not.toBeNull();
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toEqual([]);
  });

  it("removes the original, the derived files and the manifest once allowed, leaves a tombstone and queues the purge", async () => {
    const mediaId = await addItem({ kind: "video", conversion: "done", uploadedAt: new Date(Date.now() - 31 * DAY) });
    await syncManifest(mediaId);
    const before = await readItem(mediaId);

    expect(await deleteMediaPermanently(mediaId, ADMIN)).toEqual({ ok: true });

    const { privateBucket, publicBucket } = storageConfig();
    expect(await exists(privateBucket, before.originalKey)).toBe(false);
    for (const key of Object.values(before.derived)) expect(await exists(publicBucket, key), key).toBe(false);
    expect(await readManifest(mediaId)).toBeNull();
    const tombstone = await readItem(mediaId);
    expect(tombstone.deletedAt).toBeInstanceOf(Date);
    expect(await isVisible(mediaId)).toBe(false);
    // The visibility job purges these URLs from Cloudflare, then clears the keys it recorded.
    expect(tombstone.derived).toEqual(before.derived);
    expect([...(tombstone.withdrawingKeys ?? [])].sort()).toEqual([before.originalKey, ...Object.values(before.derived)].sort());
    expect((await jobsOf(MEDIA_QUEUES.visibility, mediaId)).map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });

  it("leaves a tombstone with no personal data: ids, times, guest and keys only (Ruling AU)", async () => {
    const guestId = await addGuest();
    const mediaId = await addItem({
      guestId,
      uploadedAt: new Date(Date.now() - 31 * DAY),
      uploaderName: "Ama Owusu",
      originalFilename: "Ama at the reception.JPG",
      fileFingerprint: "f".repeat(64),
      capturedAt: new Date("2026-12-05T20:00:00Z"),
    });
    const before = await readItem(mediaId);

    await deleteMediaPermanently(mediaId, ADMIN);

    expect(await readItem(mediaId)).toMatchObject({
      id: mediaId,
      guestId,
      originalKey: before.originalKey,
      uploadedAt: before.uploadedAt,
      // Null where it may be; a fixed placeholder where it can't.
      uploaderName: null,
      originalFilename: "deleted",
      fileFingerprint: null,
      thumbhash: null,
      averageColor: null,
    });
  });

  it("takes down the public files first, so R2 refusing the original after the response leaves nothing reachable", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const mediaId = await addItem({ uploadedAt: new Date(Date.now() - 31 * DAY) });
    const before = await readItem(mediaId);
    originals.deleteFails = true;

    expect(await deleteMediaPermanently(mediaId, ADMIN)).toEqual({ ok: true });

    const { privateBucket, publicBucket } = storageConfig();
    for (const key of Object.values(before.derived)) expect(await exists(publicBucket, key), key).toBe(false);
    expect(await exists(privateBucket, before.originalKey)).toBe(true);
    // Recorded, so its visibility job, queued all the same, finishes it.
    expect((await readItem(mediaId)).withdrawingKeys).toContain(before.originalKey);
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(1);
    expect(errors.mock.calls.flat().join(" ")).toContain(`media=${mediaId}'s deletion didn't finish here`);
  });

  it("is safe twice (Ruling AG): the second finds the tombstone and finishes the same way", async () => {
    const mediaId = await addItem({ uploadedAt: new Date(Date.now() - 31 * DAY) });
    await deleteMediaPermanently(mediaId, ADMIN);
    const first = await readItem(mediaId);

    expect(await deleteMediaPermanently(mediaId, ADMIN)).toEqual({ ok: true });
    expect((await readItem(mediaId)).deletedAt).toEqual(first.deletedAt);
  });

  it("refuses an upload that never finished, and finds nothing for an unknown id", async () => {
    const uploading = await addItem({ status: "uploading" });
    expect(await deleteMediaPermanently(uploading, ADMIN)).toEqual({ ok: false, reason: "not-uploaded" });
    expect(await deleteMediaPermanently(randomUUID(), ADMIN)).toEqual({ ok: false, reason: "not-found" });
    expect(await deleteMediaPermanently("not-a-uuid", ADMIN)).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("the manifest, written from the database's current state (manifest writes converge)", () => {
  it("is written again when a hide's write lands before a stale one: hidden is never lost", async () => {
    const mediaId = await addItem();
    const stale = {
      celebration: "reception" as const,
      celebrationSetByAdmin: false,
      hiddenAt: null,
      hiddenBy: null,
      removedByUploader: false,
      deletedAt: null,
    };
    // A processing job's write, its facts read before the hide, is held until the hide has written its own.
    manifests.beforeNextWrite = async () => {
      await hideMedia(mediaId, { admin: ADMIN });
    };

    await syncManifest(mediaId, { known: stale });

    expect(manifests.writes.map((write) => write.hidden)).toEqual([true, false, true]);
    expect(await readManifest(mediaId)).toMatchObject({ hiddenBy: ADMIN, hiddenAt: (await readItem(mediaId)).hiddenAt });
  });

  it("is removed, not written, for a deleted item or one whose row is gone", async () => {
    const deleted = await addItem({ deletedAt: new Date() });
    const gone = randomUUID();
    privateKeys.push(manifestKey(gone));
    const { privateBucket } = storageConfig();
    for (const mediaId of [deleted, gone]) {
      await putObject(privateBucket, manifestKey(mediaId), "{}");
      await syncManifest(mediaId);
      expect(await exists(privateBucket, manifestKey(mediaId)), mediaId).toBe(false);
    }
  });
});

describe("wishes", () => {
  async function voiceWish(mediaValues: Partial<typeof media.$inferInsert> = {}) {
    const mediaId = await addItem({ purpose: "wish", kind: "audio", ...mediaValues });
    const wish = await addWish({ kind: "voice", mediaId, signedAs: "Ama" });
    return { wishId: wish.id, mediaId };
  }

  it("hideWish takes a text wish off the wall", async () => {
    const wish = await addWish({ kind: "text", message: "Congratulations!", signedAs: "Ama" });

    expect(await hideWish(wish.id, ADMIN)).toEqual({ ok: true });

    expect(await listWishes()).toEqual([]);
    const [row] = await getDb().select().from(wishes).where(eq(wishes.id, wish.id));
    expect(row).toMatchObject({ hiddenBy: ADMIN });
  });

  it("hideWish and unhideWish act on a voice wish's recording too", async () => {
    const { wishId, mediaId } = await voiceWish();

    await hideWish(wishId, ADMIN);
    expect(await isVisible(mediaId)).toBe(false);
    expect(await jobsOf(MEDIA_QUEUES.visibility, mediaId)).toHaveLength(1);

    expect(await unhideWish(wishId, ADMIN)).toEqual({ ok: true });
    expect(await isVisible(mediaId)).toBe(true);
    expect((await listWishes()).map((wish) => wish.id)).toEqual([wishId]);
    expect(await jobsOf(MEDIA_QUEUES.wish, mediaId)).toHaveLength(1);
  });

  it("deleteWishPermanently removes a text wish's words and signature at once, leaving a tombstone (Ruling AU)", async () => {
    const wish = await addWish({ kind: "text", message: "Congratulations!", signedAs: "Ama" });

    expect(await deleteWishPermanently(wish.id, ADMIN)).toEqual({ ok: true });

    expect(await listWishes()).toEqual([]);
    const [row] = await getDb().select().from(wishes).where(eq(wishes.id, wish.id));
    expect(row.deletedAt).toBeInstanceOf(Date);
    // Neither may be null: a fixed placeholder, and an empty message.
    expect(row).toMatchObject({ signedAs: "deleted", message: "" });
  });

  it("deleteWishPermanently waits for a recording's lock, and deletes both once it allows", async () => {
    const uploadedAt = new Date(Date.now() - 3 * DAY);
    const early = await voiceWish({ uploadedAt });
    expect(await deleteWishPermanently(early.wishId, ADMIN)).toEqual({
      ok: false,
      reason: "locked",
      allowedFrom: deletableFrom(uploadedAt),
    });
    expect((await listWishes()).map((wish) => wish.id)).toEqual([early.wishId]);

    const late = await voiceWish({ uploadedAt: new Date(Date.now() - 40 * DAY) });
    expect(await deleteWishPermanently(late.wishId, ADMIN)).toEqual({ ok: true });
    expect((await readItem(late.mediaId)).deletedAt).toBeInstanceOf(Date);
    expect((await listWishes()).map((wish) => wish.id)).toEqual([early.wishId]);
  });

  it("finds nothing for an unknown wish, and is safe twice (Ruling AG)", async () => {
    for (const action of [hideWish, unhideWish, deleteWishPermanently]) {
      expect(await action(randomUUID(), ADMIN)).toEqual({ ok: false, reason: "not-found" });
      expect(await action("not-a-uuid", ADMIN)).toEqual({ ok: false, reason: "not-found" });
    }
    const wish = await addWish({ kind: "text", message: "Hello", signedAs: "Ama" });
    await hideWish(wish.id, ADMIN);
    expect(await hideWish(wish.id, ADMIN)).toEqual({ ok: true });
    await deleteWishPermanently(wish.id, ADMIN);
    expect(await deleteWishPermanently(wish.id, ADMIN)).toEqual({ ok: true });
  });
});

describe("the two switches", () => {
  it("setUploadsOpen opens uploads, and closing records when, which the 24 hours of grace count from", async () => {
    await setUploadsOpen(true, ADMIN);
    expect(await readUploadsSwitch()).toEqual({ open: true, closedAt: null });

    const before = Date.now();
    await setUploadsOpen(false, ADMIN);
    const closed = await readUploadsSwitch();
    expect(closed.open).toBe(false);
    expect(closed.closedAt?.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(closed.closedAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("closing again keeps the first close's time (Ruling AG), so the grace isn't stretched", async () => {
    await setUploadsOpen(true, ADMIN);
    await setUploadsOpen(false, ADMIN);
    const first = await readUploadsSwitch();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await setUploadsOpen(false, ADMIN);

    expect(await readUploadsSwitch()).toEqual(first);
  });

  it("reopening keeps the last close's time as history, and a later close records its own", async () => {
    await setUploadsOpen(true, ADMIN);
    await setUploadsOpen(false, ADMIN);
    const closedAt = await getSetting("uploads_closed_at", null);

    await setUploadsOpen(true, ADMIN);
    expect(await readUploadsSwitch()).toEqual({ open: true, closedAt: new Date(closedAt ?? "") });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await setUploadsOpen(false, ADMIN);
    expect((await readUploadsSwitch()).closedAt?.getTime()).toBeGreaterThan(new Date(closedAt ?? "").getTime());
  });

  it("closing uploads that were never opened (the migration's false) changes nothing", async () => {
    await setSetting("uploads_open", false);
    await setUploadsOpen(false, ADMIN);
    expect(await getSetting("uploads_closed_at", null)).toBeNull();
  });

  it("setConvertBacklog switches the backlog conversions, which the worker follows", async () => {
    await setConvertBacklog(false, ADMIN);
    expect(await getSetting("convert_backlog", true)).toBe(false);
    await setConvertBacklog(true, ADMIN);
    expect(await getSetting("convert_backlog", false)).toBe(true);
  });
});
