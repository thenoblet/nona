import { randomBytes, randomUUID } from "node:crypto";
import { DeleteObjectsCommand, UploadPartCommand, type S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest, findGuestById } from "@/lib/data/guests";
import { setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { guests, media, uploadEvents } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES, type MediaQueueName } from "@/lib/jobs/media-queues";
import { PART_SIZE_BYTES, SIZE_LIMITS } from "@/lib/media/limits";
import { createStorageClient, storageClient } from "@/lib/storage/client";
import { manifestKey, originalKey } from "@/lib/storage/keys";
import { readManifest } from "@/lib/storage/manifest";
import { abortMultipart, completeMultipart, headOriginal, listUploadedParts } from "@/lib/storage/objects";
import { resetDb } from "../../../../test/db";
import { asBrowser, browserCookies, newCookieJar, type CookieJar } from "../../../../test/next-cookies";
import {
  dropBossSchema,
  jsonRequest,
  newFingerprint,
  putPart,
  routeContext,
  startTestBoss,
} from "../../../../test/uploads";

// These run against the local MinIO and test database: docker compose up -d db minio && npm run storage:init.

vi.mock("next/headers", () => import("../../../../test/next-cookies"));

// after() runs its task once the response is sent; the tests wait for exactly those tasks.
const afterTasks = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    afterTasks.push(Promise.resolve().then(task));
  },
  connection: async () => {},
}));

/** Waits for every task the routes handed to after(). */
async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0));
}

vi.mock("@/lib/content/get", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { getSiteContent: async () => contentDefaults };
});

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
            throw Object.assign(new Error("send failed for Ama Owusu's IMG_0001.JPG"), { code: "57P01" });
          },
        };
      }
      if (!queue.boss) throw new Error("The test queue isn't started");
      return queue.boss;
    },
  };
});

import { guestCookieName, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { hideMedia } from "@/lib/media/moderation";
import { POST as completeRoute } from "./[id]/complete/route";
import { GET as listPartsRoute, POST as presignRoute } from "./[id]/parts/route";
import { DELETE as cancelRoute } from "./[id]/route";
import { POST as startRoute } from "./route";

const BOSS_SCHEMA = "pgboss_uploads_test";
let boss: PgBoss;

type StartBody = {
  purpose: "album" | "wish";
  filename: string;
  size: number;
  contentType: string;
  fingerprint: string;
  capturedAt?: string | null;
  uploaderName?: string | null;
};

type Session = {
  mediaId: string;
  uploadId: string;
  key: string;
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; etag: string; size: number }[];
};

type SentPart = { partNumber: number; etag: string };

/** An album photo two parts long (8 MiB and a little more), a new file each time. */
function photo(overrides: Partial<StartBody> = {}): StartBody {
  return {
    purpose: "album",
    filename: "IMG_0001.JPG",
    size: PART_SIZE_BYTES + 1000,
    contentType: "image/jpeg",
    fingerprint: newFingerprint(),
    ...overrides,
  };
}

/** A one-part file of a few KB, for tests that don't need two parts. */
function smallFile(overrides: Partial<StartBody> = {}): StartBody {
  return photo({ size: 4000, ...overrides });
}

/** Every upload the tests started, so afterEach clears what each left in MinIO, row or no row. */
const startedUploads: Session[] = [];

async function start(body: unknown): Promise<Response> {
  const response = await startRoute(jsonRequest("/api/uploads", "POST", body));
  if (response.status === 200) startedUploads.push(await response.clone().json());
  return response;
}
const presign = (mediaId: string, partNumbers: unknown) =>
  presignRoute(jsonRequest(`/api/uploads/${mediaId}/parts`, "POST", { partNumbers }), routeContext(mediaId));
const listParts = (mediaId: string) =>
  listPartsRoute(jsonRequest(`/api/uploads/${mediaId}/parts`, "GET"), routeContext(mediaId));
const complete = (mediaId: string, parts: SentPart[]) =>
  completeRoute(jsonRequest(`/api/uploads/${mediaId}/complete`, "POST", { parts }), routeContext(mediaId));
const cancel = (mediaId: string) => cancelRoute(jsonRequest(`/api/uploads/${mediaId}`, "DELETE"), routeContext(mediaId));

/** Starts an upload and returns its session, failing the test on anything but 200. */
async function startSession(body: StartBody): Promise<Session> {
  const response = await start(body);
  if (response.status !== 200) throw new Error(`start answered ${response.status}: ${await response.text()}`);
  return response.json();
}

/** The file's bytes for part `partNumber` (1-based). */
function partBytes(bytes: Buffer, partNumber: number): Buffer {
  return bytes.subarray((partNumber - 1) * PART_SIZE_BYTES, partNumber * PART_SIZE_BYTES);
}

/** Presigns and PUTs these parts of the file, as the phone does, returning each part's ETag. */
async function sendParts(session: Session, bytes: Buffer, partNumbers: number[]): Promise<SentPart[]> {
  const presigned = await presign(session.mediaId, partNumbers);
  if (presigned.status !== 200) throw new Error(`presign answered ${presigned.status}: ${await presigned.text()}`);
  const { urls } = (await presigned.json()) as { urls: { partNumber: number; url: string }[] };
  return Promise.all(
    urls.map(async ({ partNumber, url }) => ({ partNumber, etag: await putPart(url, partBytes(bytes, partNumber)) })),
  );
}

/** Start, every part, complete: a whole upload, returning its session. */
async function uploadWhole(body: StartBody): Promise<Session> {
  const session = await startSession(body);
  const bytes = randomBytes(body.size);
  const numbers = Array.from({ length: session.partCount }, (_, index) => index + 1);
  const parts = await sendParts(session, bytes, numbers);
  const response = await complete(session.mediaId, parts);
  if (response.status !== 200) throw new Error(`complete answered ${response.status}: ${await response.text()}`);
  return session;
}

async function mediaRow(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

async function mediaCount(): Promise<number> {
  return (await getDb().select({ id: media.id }).from(media)).length;
}

async function jobsFor(queueName: MediaQueueName, mediaId: string) {
  return boss.findJobs(queueName, { data: { mediaId } });
}

async function eventsFor(mediaId: string) {
  return getDb()
    .select({ kind: uploadEvents.kind, guestId: uploadEvents.guestId })
    .from(uploadEvents)
    .where(eq(uploadEvents.mediaId, mediaId))
    .orderBy(uploadEvents.createdAt);
}

/** A guest of this browser (the default cookie jar), as POST /api/guest would make. */
async function signIn(jar: CookieJar = browserCookies, displayName = "Ama Owusu") {
  const guest = await createGuest(displayName);
  jar.values.set(guestCookieName(), signGuestIds([guest.id]));
  return guest;
}

/** Another browser with its own guest. */
async function otherBrowser(displayName = "Kofi Mensah"): Promise<CookieJar> {
  const jar = newCookieJar();
  await signIn(jar, displayName);
  return jar;
}

/**
 * Removes what the tests left in MinIO: unfinished uploads, originals and manifests, both of the
 * rows still there and of every upload started (a cancel or a race deletes its row, not its files).
 */
async function cleanUpStorage(): Promise<void> {
  const rows = await getDb()
    .select({ mediaId: media.id, key: media.originalKey, uploadId: media.multipartUploadId })
    .from(media);
  const uploads = [...rows, ...startedUploads.splice(0)];
  await Promise.all(
    uploads.map((upload) => (upload.uploadId ? abortMultipart(upload.key, upload.uploadId).catch(() => {}) : null)),
  );
  const keys = [...new Set(uploads.flatMap((upload) => [upload.key, manifestKey(upload.mediaId)]))];
  for (let index = 0; index < keys.length; index += 1000) {
    await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: storageConfig().privateBucket,
        Delete: { Objects: keys.slice(index, index + 1000).map((key) => ({ Key: key })), Quiet: true },
      }),
    );
  }
}

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
}, 30_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
});

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
  afterTasks.length = 0;
  queue.sendFails = false;
  await setSetting("uploads_open", true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await afterResponse();
  await cleanUpStorage();
});

describe("an upload, start to finish", () => {
  it("start → parts → PUT → complete leaves the row uploaded, with its original, manifest, job and event", async () => {
    const guest = await signIn();
    const body = photo({ capturedAt: "2026-12-05T15:30:00.000Z", uploaderName: "Ama" });

    const started = await start(body);
    expect(started.status).toBe(200);
    expect(started.headers.get("Cache-Control")).toBe("private, no-store");
    const session = (await started.json()) as Session;
    expect(Object.keys(session).sort()).toEqual(["key", "mediaId", "partCount", "partSize", "uploadId", "uploadedParts"]);
    expect(session).toMatchObject({
      key: originalKey(session.mediaId, "jpg"),
      partSize: 8_388_608,
      partCount: 2,
      uploadedParts: [],
    });
    expect(session.uploadId).toEqual(expect.any(String));

    const presigned = await presign(session.mediaId, [1, 2]);
    expect(presigned.status).toBe(200);
    expect(presigned.headers.get("Cache-Control")).toBe("private, no-store");
    const { urls } = (await presigned.json()) as { urls: { partNumber: number; url: string }[] };
    expect(urls.map((part) => part.partNumber)).toEqual([1, 2]);

    const bytes = randomBytes(body.size);
    const parts = await Promise.all(
      urls.map(async ({ partNumber, url }) => ({ partNumber, etag: await putPart(url, partBytes(bytes, partNumber)) })),
    );
    // Before it completes, the row is still uploading and nothing is queued.
    expect((await mediaRow(session.mediaId)).status).toBe("uploading");

    const completed = await complete(session.mediaId, parts);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await completed.json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
    await afterResponse();

    const row = await mediaRow(session.mediaId);
    expect(row).toMatchObject({
      purpose: "album",
      kind: "photo",
      guestId: guest.id,
      uploaderName: "Ama",
      celebration: "reception",
      originalKey: session.key,
      originalFilename: "IMG_0001.JPG",
      sizeBytes: body.size,
      contentType: "image/jpeg",
      fileFingerprint: body.fingerprint,
      multipartUploadId: session.uploadId,
      capturedAt: new Date("2026-12-05T15:30:00.000Z"),
      status: "uploaded",
    });
    expect(row.uploadedAt).toBeInstanceOf(Date);

    const head = await headOriginal(session.key);
    expect(head).toMatchObject({
      size: body.size,
      contentType: "image/jpeg",
      metadata: { guestId: guest.id, uploaderName: "Ama", originalFilename: "IMG_0001.JPG", startedAt: row.startedAt },
    });
    expect(await readManifest(session.mediaId)).toMatchObject({
      celebration: "reception",
      celebrationSetByAdmin: false,
      hiddenAt: null,
      removedByUploader: false,
      deletedAt: null,
    });
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
    expect(await eventsFor(session.mediaId)).toEqual([{ kind: "completed", guestId: guest.id }]);
  });

  it("queues a video for its poster and a wish's recording for the wish job", async () => {
    await signIn();
    const cases: [StartBody, MediaQueueName, string][] = [
      [smallFile({ contentType: "video/quicktime", filename: "IMG_0002.MOV" }), MEDIA_QUEUES.poster, "video"],
      [smallFile({ purpose: "wish", contentType: "audio/mp4", filename: "wish.m4a" }), MEDIA_QUEUES.wish, "audio"],
      [smallFile({ purpose: "wish", contentType: "video/mp4", filename: "wish.mp4" }), MEDIA_QUEUES.wish, "video"],
    ];
    for (const [body, queueName, kind] of cases) {
      const session = await uploadWhole(body);
      await afterResponse();
      expect(await jobsFor(queueName, session.mediaId), body.filename).toHaveLength(1);
      expect(await mediaRow(session.mediaId), body.filename).toMatchObject({ kind, purpose: body.purpose, status: "uploaded" });
    }
  });

  it("groups an upload by when it was taken, or by when it started without a capture time", async () => {
    await signIn();
    const ceremony = await startSession(smallFile({ capturedAt: "2026-12-05T11:00:00Z" }));
    const thanks = await startSession(smallFile({ capturedAt: "2026-12-06T10:00:00+00:00" }));
    // Today (October) is no celebration's day.
    const today = await startSession(smallFile());
    expect((await mediaRow(ceremony.mediaId)).celebration).toBe("ceremony");
    expect((await mediaRow(thanks.mediaId)).celebration).toBe("thanks");
    expect((await mediaRow(today.mediaId)).celebration).toBe("more");
    expect((await readManifest(thanks.mediaId))?.celebration).toBe("thanks");
  });

  it("refuses a browser without a guest with 403 no-guest, making no guest and no upload", async () => {
    // The phone awaits POST /api/guest before its first start, so a start never makes a guest.
    const forged = newCookieJar();
    forged.values.set(guestCookieName(), "not-a-signed-value");
    for (const jar of [browserCookies, forged]) {
      const response = await asBrowser(jar, () => start(smallFile({ uploaderName: "Ama Owusu" })));
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "no-guest" });
    }
    expect(browserCookies.sets).toEqual([]);
    expect(forged.sets).toEqual([]);
    expect(await getDb().select().from(guests)).toEqual([]);
    expect(await mediaCount()).toBe(0);
  });

  it("names an upload from uploaderName without renaming the browser's guest", async () => {
    const guest = await signIn(browserCookies, "Ama Owusu");
    const session = await startSession(smallFile({ uploaderName: " Ama O. " }));
    expect(await mediaRow(session.mediaId)).toMatchObject({ guestId: guest.id, uploaderName: "Ama O." });
    expect((await findGuestById(guest.id))?.displayName).toBe("Ama Owusu");
  });

  it("gives the browser a new own guest when its cookie names one the database no longer has", async () => {
    const gone = randomUUID();
    browserCookies.values.set(guestCookieName(), signGuestIds([gone]));
    const session = await startSession(smallFile({ uploaderName: "Esi" }));
    const [guestId] = await readGuestIds();
    expect(guestId).not.toBe(gone);
    expect((await findGuestById(guestId))?.displayName).toBe("Esi");
    expect(await mediaRow(session.mediaId)).toMatchObject({ guestId, uploaderName: "Esi" });
    expect(await readManifest(session.mediaId)).toMatchObject({ celebration: "more" });
  });

  it("names an upload after its guest when no name comes with it, and keeps names and filenames bounded", async () => {
    await signIn(browserCookies, "Kofi");
    const unnamed = await startSession(smallFile());
    expect((await mediaRow(unnamed.mediaId)).uploaderName).toBe("Kofi");

    const long = await startSession(
      smallFile({ uploaderName: "A".repeat(500), filename: `C:\\phone\\${"b".repeat(300)}\u0000.jpg` }),
    );
    const row = await mediaRow(long.mediaId);
    expect(row.uploaderName).toBe("A".repeat(80));
    expect(row.originalFilename).toBe("b".repeat(255));
    expect(long.key).toBe(originalKey(long.mediaId, "jpg"));
  });
});

describe("resuming", () => {
  it("Review Focus 1: re-picking the same file, renamed, resumes it with the parts already sent", async () => {
    const guest = await signIn();
    const body = photo();
    const first = await startSession(body);
    const bytes = randomBytes(body.size);
    const [sentFirst] = await sendParts(first, bytes, [1]);

    // The tab closed; the guest picks the same file again, which the phone has renamed.
    const again = await start({ ...body, filename: "IMG_0001 (1).JPG" });
    expect(again.status).toBe(200);
    const resumed = (await again.json()) as Session;
    expect(resumed).toEqual({
      ...first,
      uploadedParts: [{ partNumber: 1, etag: sentFirst.etag, size: PART_SIZE_BYTES }],
    });

    const listed = await listParts(first.mediaId);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await listed.json()).toEqual({ parts: resumed.uploadedParts });

    const [sentSecond] = await sendParts(resumed, bytes, [2]);
    expect((await complete(first.mediaId, [sentFirst, sentSecond])).status).toBe(200);
    await afterResponse();
    expect(await mediaCount()).toBe(1);
    expect((await mediaRow(first.mediaId)).originalFilename).toBe("IMG_0001.JPG");
    expect((await headOriginal(first.key))?.size).toBe(body.size);
    expect(await eventsFor(first.mediaId)).toEqual([
      { kind: "resumed", guestId: guest.id },
      { kind: "completed", guestId: guest.id },
    ]);
  });

  it("starts a new upload for another size, another purpose or another guest's file", async () => {
    await signIn();
    const body = photo();
    const first = await startSession(body);
    expect((await startSession({ ...body, size: body.size + 1 })).mediaId).not.toBe(first.mediaId);
    expect((await startSession({ ...body, purpose: "wish", contentType: "video/mp4", filename: "a.mp4" })).mediaId).not.toBe(
      first.mediaId,
    );
    const stranger = await otherBrowser();
    const theirs = await asBrowser(stranger, () => startSession(body));
    expect(theirs.mediaId).not.toBe(first.mediaId);
  });

  it("picks up a row whose start stopped before its multipart upload began", async () => {
    const guest = await signIn();
    const body = smallFile();
    // The row was written, then R2 failed and the clean-up failed too.
    const mediaId = randomUUID();
    await getDb().insert(media).values({
      id: mediaId,
      purpose: "album",
      kind: "photo",
      guestId: guest.id,
      uploaderName: "Ama",
      celebration: "more",
      originalKey: originalKey(mediaId, "jpg"),
      originalFilename: "IMG_0001.JPG",
      sizeBytes: body.size,
      contentType: "image/jpeg",
      fileFingerprint: body.fingerprint,
      startedAt: new Date(),
    });

    const session = await startSession(body);
    expect(session).toMatchObject({ mediaId, uploadedParts: [], partCount: 1 });
    expect((await mediaRow(mediaId)).multipartUploadId).toBe(session.uploadId);
    expect(await readManifest(mediaId)).toMatchObject({ celebration: "more" });
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    expect((await complete(mediaId, parts)).status).toBe(200);
  });

  it("starts afresh when the unfinished upload has expired (R2's 7-day rule aborted it)", async () => {
    await signIn();
    const body = photo();
    const first = await startSession(body);
    await abortMultipart(first.key, first.uploadId);

    const fresh = await startSession(body);
    expect(fresh.mediaId).not.toBe(first.mediaId);
    expect(fresh.uploadedParts).toEqual([]);
    expect(await mediaRow(first.mediaId)).toBeUndefined();
    expect(await mediaCount()).toBe(1);
  });

  it("finishes an upload whose completion answer was lost, listing every part as sent", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1, 2]);
    // R2 joined the parts, but the app never marked the row (its answer was lost).
    await completeMultipart(session.key, session.uploadId, parts);

    const again = await startSession({ ...body, filename: "renamed.jpg" });
    expect(again.mediaId).toBe(session.mediaId);
    expect(again.uploadedParts).toEqual([
      { partNumber: 1, etag: "", size: PART_SIZE_BYTES },
      { partNumber: 2, etag: "", size: 1000 },
    ]);
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
    // The phone, seeing nothing left to send, completes: that answers at once.
    expect(await (await complete(session.mediaId, again.uploadedParts)).json()).toEqual({
      mediaId: session.mediaId,
      status: "uploaded",
    });
    expect(await (await listParts(session.mediaId)).json()).toEqual({ parts: again.uploadedParts });
  });
});

describe("completing", () => {
  it("answers 409 incomplete when a part is missing, leaving the row uploading and nothing queued", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const bytes = randomBytes(body.size);
    const [first] = await sendParts(session, bytes, [1]);

    const response = await complete(session.mediaId, [first]);
    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "incomplete",
      message: expect.stringMatching(/hasn't all arrived/),
    });
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploading");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(0);
    expect(await eventsFor(session.mediaId)).toEqual([]);

    // The phone sends the missing part and completes again.
    const [second] = await sendParts(session, bytes, [2]);
    expect((await complete(session.mediaId, [first, second])).status).toBe(200);
  });

  it("is fine to call twice, one after the other or at once, queueing one job and one event", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);

    const [first, second] = await Promise.all([complete(session.mediaId, parts), complete(session.mediaId, parts)]);
    const third = await complete(session.mediaId, parts);
    for (const response of [first, second, third]) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
    }
    await afterResponse();
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
    expect(await eventsFor(session.mediaId)).toHaveLength(1);
  });

  it("counts NoSuchUpload after a real completion as success, when the original is there", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1, 2]);
    // An earlier complete reached R2, then its answer was lost before the row was marked.
    await completeMultipart(session.key, session.uploadId, parts);
    await expect(listUploadedParts(session.key, session.uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });

    const response = await complete(session.mediaId, parts);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
  });

  it("answers 409 upload-missing when neither the upload nor the original is there, keeping the row", async () => {
    await signIn();
    const session = await startSession(smallFile());
    await abortMultipart(session.key, session.uploadId);
    const response = await complete(session.mediaId, []);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("upload-missing");
    expect((await mediaRow(session.mediaId)).status).toBe("uploading");
  });

  it("Ruling V: finishes on the server when the phone drops mid-complete, the row uploaded and its job queued", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    // The phone goes to the background as R2 is asked for the parts: the request's signal fires.
    const phone = new AbortController();
    const middleware = "dropThePhoneDuringListParts";
    storageClient().middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "ListPartsCommand") phone.abort(new Error("the phone went to the background"));
        return next(args);
      },
      { step: "initialize", name: middleware },
    );
    let response: Response;
    try {
      response = await completeRoute(
        new Request(`https://example.com/api/uploads/${session.mediaId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts }),
          signal: phone.signal,
        }),
        routeContext(session.mediaId),
      );
    } finally {
      storageClient().middlewareStack.remove(middleware);
    }
    expect(phone.signal.aborted).toBe(true);
    expect(response.status).toBe(200);
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
  });

  /** Runs `during` inside R2's CompleteMultipartUpload, before R2 joins the parts or just after. */
  async function aroundTheJoin<TResult>(
    when: "before" | "after",
    during: () => Promise<void>,
    request: () => Promise<TResult>,
  ): Promise<TResult> {
    const middleware = `${when}TheJoin`;
    storageClient().middlewareStack.add(
      (next, context) => async (args) => {
        const joining = context.commandName === "CompleteMultipartUploadCommand";
        if (joining && when === "before") await during();
        const result = await next(args);
        if (joining && when === "after") await during();
        return result;
      },
      { step: "initialize", name: middleware },
    );
    try {
      return await request();
    } finally {
      storageClient().middlewareStack.remove(middleware);
    }
  }

  it("Ruling Y: a complete R2 has joined wins over a cancel that lands meanwhile, so no original is left without its row", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    let cancelled: Response | undefined;

    const response = await aroundTheJoin(
      "after",
      async () => {
        cancelled = await cancel(session.mediaId);
      },
      () => complete(session.mediaId, parts),
    );
    expect(cancelled?.status).toBe(409);
    expect(await cancelled?.json()).toMatchObject({ error: "already-uploaded" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(1);
    expect((await headOriginal(session.key))?.size).toBe(body.size);
  });

  it("deletes the row when the cancel's abort lands first, and the complete then answers upload-missing", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    let cancelled: Response | undefined;

    const response = await aroundTheJoin(
      "before",
      async () => {
        cancelled = await cancel(session.mediaId);
      },
      () => complete(session.mediaId, parts),
    );
    expect(cancelled?.status).toBe(200);
    expect(await cancelled?.json()).toEqual({ mediaId: session.mediaId, cancelled: true });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("upload-missing");
    await afterResponse();
    expect(await mediaRow(session.mediaId)).toBeUndefined();
    expect(await headOriginal(session.key)).toBeNull();
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(0);
  });

  it("answers 404 missing, queueing nothing and warning of the original left behind, when the row goes from under a complete", async () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);

    const response = await aroundTheJoin(
      "after",
      async () => {
        await getDb().delete(media).where(eq(media.id, session.mediaId));
      },
      () => complete(session.mediaId, parts),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "missing" });
    await afterResponse();
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(0);
    expect(await eventsFor(session.mediaId)).toEqual([]);
    expect(warned).toHaveBeenCalledOnce();
    expect(String(warned.mock.calls[0][0])).toContain(session.key);
  });

  it("still succeeds when the job can't be queued, leaving the item for the sweeper", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    queue.sendFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await complete(session.mediaId, parts);
    expect(response.status).toBe(200);
    await afterResponse();
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
    expect(await jobsFor(MEDIA_QUEUES.photo, session.mediaId)).toHaveLength(0);
  });
});

describe("whose upload it is", () => {
  it("answers 403 with no details to another browser's guest, to a browser without one and for an unknown id", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1, 2]);

    const stranger = await otherBrowser();
    const cookieless = newCookieJar();
    for (const jar of [stranger, cookieless]) {
      const responses = await asBrowser(jar, () =>
        Promise.all([
          presign(session.mediaId, [1]),
          listParts(session.mediaId),
          complete(session.mediaId, parts),
          cancel(session.mediaId),
        ]),
      );
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(await response.json()).toEqual({ error: "forbidden" });
      }
    }
    for (const id of [randomUUID(), "not-a-uuid"]) {
      expect((await presign(id, [1])).status).toBe(403);
      expect((await listParts(id)).status).toBe(403);
      expect((await complete(id, [])).status).toBe(403);
      expect((await cancel(id)).status).toBe(403);
    }
    expect((await mediaRow(session.mediaId)).status).toBe("uploading");
  });

  it("lets a browser that remembers the guest through their personal link carry on", async () => {
    const owner = await signIn();
    const body = smallFile();
    const session = await startSession(body);
    const secondPhone = newCookieJar();
    const ownGuest = await createGuest("Ama's other phone");
    secondPhone.values.set(guestCookieName(), signGuestIds([ownGuest.id, owner.id]));

    const listed = await asBrowser(secondPhone, () => listParts(session.mediaId));
    expect(listed.status).toBe(200);
    const parts = await asBrowser(secondPhone, () => sendParts(session, randomBytes(body.size), [1]));
    expect((await asBrowser(secondPhone, () => complete(session.mediaId, parts))).status).toBe(200);
  });
});

describe("Review Focus 5: a file that isn't what the album takes", () => {
  it("is refused before any bytes are sent, with plain words, leaving nothing behind", async () => {
    await signIn();
    const cases: [Partial<StartBody>, string][] = [
      [{ size: SIZE_LIMITS.photo + 1 }, "too-large"],
      [{ contentType: "video/mp4", filename: "clip.mp4", size: SIZE_LIMITS.video + 1 }, "too-large"],
      [{ size: 0 }, "empty-file"],
      [{ contentType: "application/pdf", filename: "invitation.pdf" }, "unsupported-type"],
      [{ contentType: "image/svg+xml", filename: "logo.svg" }, "unsupported-type"],
      [{ contentType: "image/jpeg", filename: "report.pdf" }, "unsupported-type"],
      [{ contentType: "audio/mp4", filename: "voice.m4a" }, "unsupported-type"],
      [{ contentType: "", filename: "IMG_0001.JPG" }, "unsupported-type"],
    ];
    for (const [overrides, error] of cases) {
      const response = await start(photo(overrides));
      expect(response.status, JSON.stringify(overrides)).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const answer = await response.json();
      expect(answer.error, JSON.stringify(overrides)).toBe(error);
      expect(answer.message).toMatch(/^[A-Z].+\.$/);
    }
    expect(await mediaCount()).toBe(0);
  });

  it("takes a HEIC a phone sent as application/octet-stream as image/heic, and audio for a voice wish", async () => {
    await signIn();
    const heic = await startSession(smallFile({ contentType: "application/octet-stream", filename: "IMG_4021.HEIC" }));
    expect(heic.key).toBe(originalKey(heic.mediaId, "heic"));
    expect((await mediaRow(heic.mediaId)).contentType).toBe("image/heic");

    const voice = await startSession(smallFile({ purpose: "wish", contentType: "audio/webm;codecs=opus", filename: "" }));
    expect(await mediaRow(voice.mediaId)).toMatchObject({ kind: "audio", contentType: "audio/webm", originalFilename: "" });
  });
});

describe("when the couple close uploads", () => {
  async function closeUploads(closedAt: Date): Promise<void> {
    await setSetting("uploads_open", false);
    await setSetting("uploads_closed_at", closedAt.toISOString());
  }

  it("refuses a new album upload with plain words, but never a wish", async () => {
    await signIn();
    await closeUploads(new Date());
    const response = await start(smallFile());
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "uploads-closed",
      message: "Uploads to the album have closed. Thank you for every photo and video you shared!",
    });
    expect(await mediaCount()).toBe(0);

    expect((await start(smallFile({ purpose: "wish", contentType: "audio/mp4", filename: "w.m4a" }))).status).toBe(200);
  });

  it("refuses album uploads while nothing has opened them (a fresh database), failing closed", async () => {
    await resetDb();
    await signIn();
    expect((await start(smallFile())).status).toBe(403);
  });

  it("lets an upload started before the close finish within 24 hours", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const bytes = randomBytes(body.size);
    const [first] = await sendParts(session, bytes, [1]);
    await closeUploads(new Date());

    const resumed = await startSession({ ...body, filename: "again.jpg" });
    expect(resumed.uploadedParts).toHaveLength(1);
    expect((await listParts(session.mediaId)).status).toBe(200);
    const [second] = await sendParts(resumed, bytes, [2]);
    expect((await complete(session.mediaId, [first, second])).status).toBe(200);
    // A new file in the same 24 hours is still refused.
    expect((await start(smallFile())).status).toBe(403);
  });

  it("refuses to resume, presign or complete once 24 hours have passed, but still lets the guest cancel", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const [first] = await sendParts(session, randomBytes(body.size), [1]);
    const hour = 60 * 60 * 1000;
    await getDb().update(media).set({ startedAt: new Date(Date.now() - 30 * hour) }).where(eq(media.id, session.mediaId));
    await closeUploads(new Date(Date.now() - 25 * hour));

    for (const response of [
      await start(body),
      await presign(session.mediaId, [2]),
      await listParts(session.mediaId),
      await complete(session.mediaId, [first]),
    ]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("uploads-closed");
    }
    expect((await cancel(session.mediaId)).status).toBe(200);
  });

  it("refuses to carry on an upload started after the close", async () => {
    await signIn();
    const body = smallFile();
    const session = await startSession(body);
    await closeUploads(new Date(Date.now() - 60_000));
    expect((await start(body)).status).toBe(403);
    expect((await presign(session.mediaId, [1])).status).toBe(403);
  });
});

describe("cancelling", () => {
  it("aborts the multipart upload and deletes the row, only when the guest asks", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    await sendParts(session, randomBytes(body.size), [1]);
    expect(await readManifest(session.mediaId)).not.toBeNull();

    const response = await cancel(session.mediaId);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ mediaId: session.mediaId, cancelled: true });
    expect(await mediaRow(session.mediaId)).toBeUndefined();
    // Its manifest goes with its row: a rebuild from R2 finds nothing of a cancelled upload.
    expect(await readManifest(session.mediaId)).toBeNull();
    await expect(listUploadedParts(session.key, session.uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });
    // Cancelling again finds nothing of this browser's.
    expect((await cancel(session.mediaId)).status).toBe(403);
  });

  it("refuses to presign the parts of an upload the couple hid: every presign re-checks visibility (Review Focus 3)", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    expect((await presign(session.mediaId, [1])).status).toBe(200);

    expect(await hideMedia(session.mediaId, { admin: "couple@example.com" })).toEqual({ ok: true });

    expect((await presign(session.mediaId, [1])).status).toBe(403);
  });

  it("refuses to cancel a finished upload, which is removed another way", async () => {
    await signIn();
    const session = await uploadWhole(smallFile());
    const response = await cancel(session.mediaId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("already-uploaded");
    expect((await mediaRow(session.mediaId)).status).toBe("uploaded");
  });
});

describe("requests that aren't right", () => {
  it("refuses anything but JSON, an oversized body and malformed JSON", async () => {
    await signIn();
    const notJson = await startRoute(
      new Request("https://example.com/api/uploads", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
    );
    expect(notJson.status).toBe(415);
    expect((await start({ ...smallFile(), filename: "a".repeat(20_000) })).status).toBe(413);
    const malformed = await startRoute(
      new Request("https://example.com/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(malformed.status).toBe(400);
    for (const body of [{}, { ...smallFile(), purpose: "site" }, { ...smallFile(), size: -1 }, { ...smallFile(), size: 1.5 }, { ...smallFile(), fingerprint: "x" }, { ...smallFile(), capturedAt: "yesterday" }]) {
      const response = await start(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).error).toBe("bad-request");
    }
    expect(await mediaCount()).toBe(0);
  });

  it("presigns 1 to 20 parts of the upload's own, refusing any other numbers", async () => {
    await signIn();
    const session = await startSession(photo());
    for (const partNumbers of [[], [0], [3], [1.5], Array.from({ length: 21 }, () => 1), "1"]) {
      const response = await presign(session.mediaId, partNumbers);
      expect(response.status, JSON.stringify(partNumbers)).toBe(400);
      expect((await response.json()).error).toBe("bad-request");
    }
    const response = await presign(session.mediaId, [2, 1, 2]);
    expect(response.status).toBe(200);
    expect(((await response.json()).urls as { partNumber: number }[]).map((part) => part.partNumber)).toEqual([2, 1]);
  });

  it("refuses to presign parts for an upload already finished", async () => {
    await signIn();
    const session = await uploadWhole(smallFile());
    const response = await presign(session.mediaId, [1]);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("already-uploaded");
  });
});

describe("part URLs", () => {
  it("bind each part's size: a larger body is refused, and the last part takes exactly the remainder", async () => {
    await signIn();
    const body = photo();
    const session = await startSession(body);
    const { urls } = (await (await presign(session.mediaId, [1, 2])).json()) as { urls: { url: string }[] };
    for (const { url } of urls) {
      expect(new URL(url).searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;host");
    }

    // More than a part's share of the declared size, as a client filling R2 past the limits would send.
    const refused = [
      await fetch(urls[0].url, { method: "PUT", body: new Uint8Array(PART_SIZE_BYTES + 1) }),
      await fetch(urls[1].url, { method: "PUT", body: new Uint8Array(PART_SIZE_BYTES) }),
      await fetch(urls[1].url, { method: "PUT", body: new Uint8Array(999) }),
    ];
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403]);
    expect(await listUploadedParts(session.key, session.uploadId)).toEqual([]);

    const bytes = randomBytes(body.size);
    expect(partBytes(bytes, 2)).toHaveLength(1000);
    const parts = [
      { partNumber: 1, etag: await putPart(urls[0].url, partBytes(bytes, 1)) },
      { partNumber: 2, etag: await putPart(urls[1].url, partBytes(bytes, 2)) },
    ];
    expect((await complete(session.mediaId, parts)).status).toBe(200);
  });

  it("aborts an upload whose parts hold more than it declared, should R2 ever let one through", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await signIn();
    // An upload declared at 4,000 bytes, given a 5,000-byte part behind its presigned URL's back.
    async function overfilled(): Promise<Session> {
      const session = await startSession(smallFile());
      await storageClient().send(
        new UploadPartCommand({
          Bucket: storageConfig().privateBucket,
          Key: session.key,
          UploadId: session.uploadId,
          PartNumber: 1,
          Body: randomBytes(5000),
        }),
      );
      return session;
    }

    const completing = await overfilled();
    const response = await complete(completing.mediaId, []);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "size-mismatch",
      message: "This file didn't match the size it started with. Please choose it again.",
    });
    await expect(listUploadedParts(completing.key, completing.uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });
    expect(await mediaRow(completing.mediaId)).toBeUndefined();

    const listing = await overfilled();
    expect((await listParts(listing.mediaId)).status).toBe(409);
    await expect(listUploadedParts(listing.key, listing.uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });
    expect(await mediaRow(listing.mediaId)).toBeUndefined();
    expect(logged.mock.calls.map(([message]) => message)).toEqual([
      `[uploads] ${completing.mediaId} holds more than it declared; aborting it`,
      `[uploads] ${listing.mediaId} holds more than it declared; aborting it`,
    ]);
  });
});

describe("Review Focus 4: a burst after the speeches", () => {
  it("lets one guest send a 60-photo batch without meeting a limit", async () => {
    // Hold the limiter's clock still: the whole batch lands in the same instant.
    vi.spyOn(performance, "now").mockReturnValue(5_000);
    await signIn();
    const files = Array.from({ length: 60 }, (_, index) => smallFile({ filename: `IMG_${index}.JPG` }));
    const statuses: number[] = [];
    for (let batch = 0; batch < files.length; batch += 10) {
      await Promise.all(
        files.slice(batch, batch + 10).map(async (body) => {
          const started = await start(body);
          statuses.push(started.status);
          const session = (await started.json()) as Session;
          const presigned = await presign(session.mediaId, [1]);
          statuses.push(presigned.status);
          const { urls } = await presigned.json();
          const etag = await putPart(urls[0].url, randomBytes(body.size));
          statuses.push((await complete(session.mediaId, [{ partNumber: 1, etag }])).status);
        }),
      );
    }
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(statuses).toHaveLength(180);
  }, 60_000);

  it("answers the 101st start in a burst with 429 and Retry-After, holding back no other guest", async () => {
    vi.spyOn(performance, "now").mockReturnValue(5_000);
    await signIn();
    // Refused files still count: the limit is on requests.
    for (let request = 0; request < 100; request += 1) expect((await start(smallFile({ size: 0 }))).status).toBe(400);

    const limited = await start(smallFile());
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");
    expect(limited.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await limited.json()).toMatchObject({ error: "rate-limited", retryAfterSeconds: 1 });

    // Another guest behind the same IP starts at once.
    const neighbour = await otherBrowser();
    expect((await asBrowser(neighbour, () => start(smallFile()))).status).toBe(200);
  });
});

describe("the logs", () => {
  it("never carry a guest's name, filename, fingerprint, cookie or a signed URL", async () => {
    const logged = [
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "log").mockImplementation(() => {}),
    ];
    const guest = await signIn(browserCookies, "Abena Secretname");
    const cookieValue = browserCookies.values.get(guestCookieName()) ?? "";
    const body = smallFile({ uploaderName: "Abena Secretname", filename: "Secret-Filename.jpg" });

    // R2 refuses connections: the start fails with 503 and leaves no row behind.
    const globalWithStorage = globalThis as { __nonaStorage?: S3Client };
    const realClient = globalWithStorage.__nonaStorage;
    globalWithStorage.__nonaStorage = createStorageClient({ ...storageConfig(), endpoint: "http://127.0.0.1:1" });
    try {
      const failed = await start(body);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ error: "unavailable", message: "Please try again in a moment." });
    } finally {
      globalWithStorage.__nonaStorage?.destroy();
      globalWithStorage.__nonaStorage = realClient;
    }
    expect(await mediaCount()).toBe(0);

    // The queue is down: the complete succeeds and the failure is logged.
    const session = await startSession(body);
    const parts = await sendParts(session, randomBytes(body.size), [1]);
    queue.sendFails = true;
    expect((await complete(session.mediaId, parts)).status).toBe(200);
    await afterResponse();

    const output = logged.flatMap((spy) => spy.mock.calls.flat().map((value) => String(value))).join("\n");
    expect(output).toContain("[uploads]");
    for (const secret of ["Secretname", "Secret-Filename", body.fingerprint, cookieValue, guest.id, "X-Amz-Signature", "IMG_0001"]) {
      expect(output).not.toContain(secret);
    }
  });
});
