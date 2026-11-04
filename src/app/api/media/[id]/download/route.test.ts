import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { storageConfig } from "@/lib/env";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { addAlbumItem, photoKeys, posterKeys } from "../../../../../../test/album";
import { resetDb } from "../../../../../../test/db";
import { browserCookies } from "../../../../../../test/next-cookies";
import { dropBossSchema, routeContext, startTestBoss } from "../../../../../../test/uploads";

// Against the test database and the local MinIO: docker compose up -d db minio.

vi.mock("next/headers", () => import("../../../../../../test/next-cookies"));

// after() runs its task once the response is sent: here, only when the test says so.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
  connection: async () => {},
}));

async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0).map((task) => task()));
}

// The app's job queue, played by a real pg-boss in a schema of its own.
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

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

const BOSS_SCHEMA = "pgboss_download_test";
let boss: PgBoss;
const objects: { bucket: string; key: string }[] = [];

function downloadRequest(mediaId: string, query = "", headers: Record<string, string> = {}): Request {
  return new Request(`https://example.com/api/media/${mediaId}/download${query}`, { headers });
}

/** Puts a small object in a bucket, removed again after the test. */
async function putObject(bucket: string, key: string, body: string, contentType: string): Promise<void> {
  await storageClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  objects.push({ bucket, key });
}

function linkOf(response: Response): URL {
  const location = response.headers.get("Location");
  if (!location) throw new Error("no Location");
  return new URL(location);
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
});

afterEach(async () => {
  await afterResponse();
  await Promise.all(
    objects.splice(0).map(({ bucket, key }) => storageClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {})),
  );
});

describe("GET /api/media/[id]/download", () => {
  it("redirects a visible photo to a 6-hour presigned link for its original, named NONA26-<celebration>-<short id>, never cached", async () => {
    const mediaId = randomUUID();
    await addAlbumItem({ id: mediaId, celebration: "reception" });
    await putObject(storageConfig().privateBucket, originalKey(mediaId, "jpg"), "the original bytes", "image/jpeg");

    for (const query of ["", "?variant=original"]) {
      const response = await GET(downloadRequest(mediaId, query), routeContext(mediaId));
      expect(response.status).toBe(302);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      const link = linkOf(response);
      expect(link.pathname).toBe(`/${storageConfig().privateBucket}/originals/${mediaId}.jpg`);
      expect(link.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
    }

    const download = await fetch(linkOf(await GET(downloadRequest(mediaId), routeContext(mediaId))), { signal: AbortSignal.timeout(10_000) });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("the original bytes");
    expect(download.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="NONA26-reception-${mediaId.slice(0, 8)}\\.jpg"`));
  });

  it("answers 404 for a hidden, removed or deleted moment, one not ready, a wish, a site photo, and an id that isn't one", async () => {
    const ids = [
      await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "noblet" }),
      await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addAlbumItem({ deletedAt: new Date() }),
      await addAlbumItem({ status: "uploaded" }),
      await addAlbumItem({ status: "failed", failureReason: "corrupt" }),
      await addAlbumItem({ purpose: "wish", kind: "video" }),
      // The couple's own site photo (Task 19): its id is in its public sizes' URLs, but its original stays private.
      await addAlbumItem({ purpose: "site", uploaderName: null }),
      randomUUID(),
      "not-an-id",
    ];
    for (const mediaId of ids) {
      const response = await GET(downloadRequest(mediaId), routeContext(mediaId));
      expect(response.status).toBe(404);
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("gives a video's phone version by default (the conversion, else the clean copy) as an MP4, and its original on request", async () => {
    const converted = randomUUID();
    await addAlbumItem({
      id: converted,
      kind: "video",
      celebration: "ceremony",
      derived: { ...posterKeys(converted), video: `derived/${converted}/1111111111111111/video.mp4`, playable: `derived/${converted}/2222222222222222/playable.mp4` },
    });
    const copied = randomUUID();
    await addAlbumItem({ id: copied, kind: "video", derived: { ...posterKeys(copied), playable: `derived/${copied}/2222222222222222/playable.mp4` } });
    const waiting = randomUUID();
    await addAlbumItem({ id: waiting, kind: "video", derived: posterKeys(waiting) });
    await putObject(storageConfig().publicBucket, `derived/${converted}/1111111111111111/video.mp4`, "converted", "video/mp4");

    const byDefault = linkOf(await GET(downloadRequest(converted), routeContext(converted)));
    expect(byDefault.pathname).toBe(`/${storageConfig().publicBucket}/derived/${converted}/1111111111111111/video.mp4`);
    expect(byDefault.searchParams.get("X-Amz-Expires")).toBe(String(6 * 3600));
    const fetched = await fetch(byDefault, { signal: AbortSignal.timeout(10_000) });
    expect(fetched.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="NONA26-ceremony-${converted.slice(0, 8)}\\.mp4"`));

    expect(linkOf(await GET(downloadRequest(copied, "?variant=converted"), routeContext(copied))).pathname).toMatch(/\/playable\.mp4$/);
    expect(linkOf(await GET(downloadRequest(converted, "?variant=original"), routeContext(converted))).pathname).toBe(
      `/${storageConfig().privateBucket}/originals/${converted}.mov`,
    );
    // No phone version yet: the original by default, and the phone version isn't ready.
    expect(linkOf(await GET(downloadRequest(waiting), routeContext(waiting))).pathname).toMatch(/\/originals\//);
    const notReady = await GET(downloadRequest(waiting, "?variant=converted"), routeContext(waiting));
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toEqual({ error: "not-ready" });
  });

  it("makes a HEIC's JPEG on its first request (media.jpeg, after the response), then serves it", async () => {
    const mediaId = randomUUID();
    await addAlbumItem({ id: mediaId, contentType: "image/heic", originalKey: originalKey(mediaId, "heic") });

    const first = await GET(downloadRequest(mediaId, "?variant=jpeg", { Accept: "application/json" }), routeContext(mediaId));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "preparing" });
    expect(Number(first.headers.get("Retry-After"))).toBeGreaterThan(0);
    // A guest asking again while it is made sends no second job.
    await GET(downloadRequest(mediaId, "?variant=jpeg"), routeContext(mediaId));
    await afterResponse();
    const jobs = await boss.findJobs<{ mediaId: string }>(MEDIA_QUEUES.jpeg, { data: { mediaId } });
    expect(jobs.map((job) => job.data)).toEqual([{ mediaId }]);

    // Once made, the JPEG is served under the album's name.
    const jpegKey = `derived/${mediaId}/3333333333333333/jpeg.jpg`;
    await resetDb();
    await addAlbumItem({ id: mediaId, contentType: "image/heic", originalKey: originalKey(mediaId, "heic"), derived: { ...photoKeys(mediaId), jpeg: jpegKey } });
    const ready = await GET(downloadRequest(mediaId, "?variant=jpeg", { Accept: "application/json" }), routeContext(mediaId));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: "ready",
      url: expect.stringContaining(`/${storageConfig().publicBucket}/${jpegKey}?`),
      filename: `NONA26-reception-${mediaId.slice(0, 8)}.jpg`,
    });
    expect(linkOf(await GET(downloadRequest(mediaId, "?variant=jpeg"), routeContext(mediaId))).pathname).toBe(`/${storageConfig().publicBucket}/${jpegKey}`);
  });

  it("offers no JPEG of a photo that isn't a HEIC, and refuses a variant it doesn't know", async () => {
    const mediaId = await addAlbumItem({});
    expect((await GET(downloadRequest(mediaId, "?variant=jpeg"), routeContext(mediaId))).status).toBe(404);
    expect((await GET(downloadRequest(mediaId, "?variant=thumb"), routeContext(mediaId))).status).toBe(400);
    await afterResponse();
    expect(await boss.findJobs(MEDIA_QUEUES.jpeg, { data: { mediaId } })).toEqual([]);
  });

  it("answers with the link as JSON when the phone asks for it (Save to Photos fetches the file itself)", async () => {
    const mediaId = await addAlbumItem({ celebration: "thanks" });
    const response = await GET(downloadRequest(mediaId, "", { Accept: "application/json" }), routeContext(mediaId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ready",
      url: expect.stringContaining(`/originals/${mediaId}.jpg?`),
      filename: `NONA26-thanksgiving-${mediaId.slice(0, 8)}.jpg`,
    });
  });

  it("is limited per guest once the browser has one: past the burst it answers 429 with Retry-After", async () => {
    const guest = await createGuest("Ama Owusu");
    browserCookies.values.set(guestCookieName(), signGuestIds([guest.id]));
    const mediaId = await addAlbumItem({});
    for (let request = 0; request < RATE_LIMITS.download.burst; request += 1) takeToken(guest.id, "download");
    const response = await GET(downloadRequest(mediaId), routeContext(mediaId));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
