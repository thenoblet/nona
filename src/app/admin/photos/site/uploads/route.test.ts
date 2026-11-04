import { randomBytes } from "node:crypto";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { PART_SIZE_BYTES } from "@/lib/media/limits";
import { storageClient } from "@/lib/storage/client";
import { abortMultipart } from "@/lib/storage/objects";
import { TEST_STORAGE_ENV } from "../../../../../../test/env";
import { resetDb } from "../../../../../../test/db";
import { asBrowser, newCookieJar } from "../../../../../../test/next-cookies";
import { sitePhotoKeys } from "../../../../../../test/site-images";
import { dropBossSchema, jsonRequest, putPart, routeContext, startTestBoss } from "../../../../../../test/uploads";

// Against the test database and the local MinIO: docker compose up -d db minio && npm run storage:init.

vi.mock("next/headers", () => import("../../../../../../test/next-cookies"));

const afterTasks = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => void afterTasks.push(Promise.resolve().then(task)),
  connection: async () => {},
}));

async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0));
}

vi.mock("@/lib/content/get", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { getSiteContent: async () => contentDefaults };
});

const admin = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/admin/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/admin/access")>();
  return {
    ...real,
    requireAdmin: async () => {
      if (!admin.allowed) throw new real.AdminAccessError();
      return { email: "couple@example.com" };
    },
  };
});

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

import { POST as publicComplete } from "@/app/api/uploads/[id]/complete/route";
import { POST as publicPresign } from "@/app/api/uploads/[id]/parts/route";
import { POST as completeRoute } from "./[id]/complete/route";
import { POST as presignRoute } from "./[id]/parts/route";
import { GET as statusRoute } from "./[id]/route";
import { POST as startRoute } from "./route";

const BOSS_SCHEMA = "pgboss_site_uploads_test";
let boss: PgBoss;
const sessions: { key: string; uploadId: string }[] = [];
const objectKeys: string[] = [];

type Session = { mediaId: string; uploadId: string; key: string; partSize: number; partCount: number };

const start = (body: unknown) => startRoute(jsonRequest("/admin/photos/site/uploads", "POST", body));
const presign = (mediaId: string, partNumbers: number[]) =>
  presignRoute(jsonRequest(`/admin/photos/site/uploads/${mediaId}/parts`, "POST", { partNumbers }), routeContext(mediaId));
const complete = (mediaId: string, parts: { partNumber: number; etag: string }[]) =>
  completeRoute(jsonRequest(`/admin/photos/site/uploads/${mediaId}/complete`, "POST", { parts }), routeContext(mediaId));
const status = (mediaId: string) => statusRoute(jsonRequest(`/admin/photos/site/uploads/${mediaId}`, "GET"), routeContext(mediaId));

function photo(overrides: Record<string, unknown> = {}) {
  return { filename: "pre-wedding-01.jpg", size: PART_SIZE_BYTES + 2000, contentType: "image/jpeg", ...overrides };
}

async function startSession(body = photo()): Promise<Session> {
  const response = await start(body);
  expect(response.status).toBe(200);
  const session = (await response.json()) as Session;
  sessions.push(session);
  objectKeys.push(session.key, `manifests/${session.mediaId}.json`);
  return session;
}

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
  const { privateBucket } = storageConfig();
  if (objectKeys.length > 0) {
    await storageClient().send(
      new DeleteObjectsCommand({ Bucket: privateBucket, Delete: { Objects: objectKeys.map((key) => ({ Key: key })), Quiet: true } }),
    );
  }
});

beforeEach(async () => {
  await resetDb();
  admin.allowed = true;
});

afterEach(async () => {
  await afterResponse();
  for (const session of sessions.splice(0)) await abortMultipart(session.key, session.uploadId).catch(() => {});
});

describe("the admin's site-photo uploads", () => {
  it("refuse anyone but the couple: no row, no upload, nothing cached", async () => {
    admin.allowed = false;
    const mediaId = "6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11";
    for (const response of [
      await start(photo()),
      await presign(mediaId, [1]),
      await complete(mediaId, [{ partNumber: 1, etag: "x" }]),
      await status(mediaId),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(await getDb().select().from(media)).toEqual([]);
  });

  it("start a site photo's multipart upload, with no guest, in 8 MiB parts", async () => {
    const session = await startSession();
    expect(session).toMatchObject({ partSize: PART_SIZE_BYTES, partCount: 2 });
    const [row] = await getDb().select().from(media).where(eq(media.id, session.mediaId));
    expect(row).toMatchObject({ purpose: "site", kind: "photo", guestId: null, uploaderName: null, status: "uploading" });
    expect(row.originalKey).toBe(`originals/${session.mediaId}.jpg`);
  });

  it("take photos only, up to the album's 50 MB", async () => {
    for (const body of [
      photo({ filename: "clip.mov", contentType: "video/quicktime" }),
      photo({ filename: "logo.svg", contentType: "image/svg+xml" }),
      photo({ size: 51 * 1024 * 1024 }),
      photo({ size: 0 }),
    ]) {
      const response = await start(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getDb().select().from(media)).toEqual([]);
  });

  it("send the parts straight to storage, complete once they add up, and queue the photo job", async () => {
    const session = await startSession();
    const presigned = await presign(session.mediaId, [1, 2]);
    expect(presigned.status).toBe(200);
    const { urls } = (await presigned.json()) as { urls: { partNumber: number; url: string }[] };
    const bytes = randomBytes(PART_SIZE_BYTES + 2000);
    const parts = [
      { partNumber: 1, etag: await putPart(urls[0].url, bytes.subarray(0, PART_SIZE_BYTES)) },
      { partNumber: 2, etag: await putPart(urls[1].url, bytes.subarray(PART_SIZE_BYTES)) },
    ];
    const completed = await complete(session.mediaId, parts);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
    await afterResponse();
    const jobs = await boss.findJobs<{ mediaId: string }>(MEDIA_QUEUES.photo, { data: { mediaId: session.mediaId } });
    expect(jobs).toHaveLength(1);
    expect(await (await status(session.mediaId)).json()).toEqual({ mediaId: session.mediaId, status: "uploaded" });
  });

  it("can't be carried on through the guests' upload API", async () => {
    const session = await startSession();
    await asBrowser(newCookieJar(), async () => {
      const presigned = await publicPresign(jsonRequest(`/api/uploads/${session.mediaId}/parts`, "POST", { partNumbers: [1] }), routeContext(session.mediaId));
      expect([403, 429]).toContain(presigned.status);
      const completed = await publicComplete(
        jsonRequest(`/api/uploads/${session.mediaId}/complete`, "POST", { parts: [] }),
        routeContext(session.mediaId),
      );
      expect([403, 429]).toContain(completed.status);
    });
  });

  it("answer the photo's sizes once the worker has made them, for the editor", async () => {
    const session = await startSession();
    const derived = sitePhotoKeys(session.mediaId);
    await getDb()
      .update(media)
      .set({ status: "ready", derived, width: 3000, height: 2000, averageColor: "#6b5a52" })
      .where(eq(media.id, session.mediaId));
    expect(await (await status(session.mediaId)).json()).toEqual({
      mediaId: session.mediaId,
      status: "ready",
      photo: {
        url: `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${derived.medium}`,
        thumbUrl: `${TEST_STORAGE_ENV.MEDIA_BASE_URL}/${derived.thumb}`,
        width: 3000,
        height: 2000,
      },
    });
  });

  it("say a photo the worker couldn't read failed, with its reason", async () => {
    const session = await startSession();
    await getDb().update(media).set({ status: "failed", failureReason: "corrupt" }).where(eq(media.id, session.mediaId));
    expect(await (await status(session.mediaId)).json()).toEqual({ mediaId: session.mediaId, status: "failed", reason: "corrupt" });
  });

  it("answer 404 for anything that isn't a site photo", async () => {
    const response = await status("6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11");
    expect(response.status).toBe(404);
  });
});
