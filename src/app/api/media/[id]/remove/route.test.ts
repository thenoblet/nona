import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { isVisible } from "@/lib/media/rows";
import { originalKey } from "@/lib/storage/keys";
import { deleteManifest, readManifest } from "@/lib/storage/manifest";
import { resetDb } from "../../../../../../test/db";
import { browserCookies } from "../../../../../../test/next-cookies";
import { dropBossSchema, routeContext, startTestBoss } from "../../../../../../test/uploads";

// These run against the test database and the local MinIO: docker compose up -d db minio.

vi.mock("next/headers", () => import("../../../../../../test/next-cookies"));

// after() runs its task once the response is sent: here, only when the test says the response is
// done, so a test can see what happened before and after.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
  connection: async () => {},
}));

/** Runs, and waits for, every task the route handed to after(). */
async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0).map((task) => task()));
}

const cache = vi.hoisted(() => ({ revalidated: [] as unknown[][] }));
vi.mock("next/cache", () => ({
  revalidateTag: (...input: unknown[]) => {
    cache.revalidated.push(input);
  },
}));

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
import { POST } from "./route";

const BOSS_SCHEMA = "pgboss_remove_test";
let boss: PgBoss;
const itemsMade: string[] = [];

/** This browser (the default cookie jar) as these guests, its own first. */
function asGuests(...guestIds: string[]): void {
  browserCookies.values.set(guestCookieName(), signGuestIds(guestIds));
}

/** A photo in the album as processing leaves it: ready and listed, uploaded by `guestId`. */
async function addPhoto(guestId: string | null): Promise<string> {
  const id = randomUUID();
  itemsMade.push(id);
  await getDb().insert(media).values({
    id,
    purpose: "album",
    kind: "photo",
    guestId,
    uploaderName: "Ama Owusu",
    celebration: "reception",
    originalKey: originalKey(id, "jpg"),
    originalFilename: "IMG_0001.JPG",
    sizeBytes: 3_000_000,
    contentType: "image/jpeg",
    status: "ready",
    uploadedAt: new Date("2026-12-05T18:00:00Z"),
    listedAt: new Date("2026-12-05T18:00:05Z"),
  });
  return id;
}

/** The remove request as the phone sends it, with a signal of its own that a test can abort. */
function removeRequest(mediaId: string, signal?: AbortSignal): Request {
  return new Request(`https://example.com/api/media/${mediaId}/remove`, { method: "POST", signal });
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

async function visibilityJobs(mediaId: string) {
  return boss.findJobs<{ mediaId: string; action: string }>(MEDIA_QUEUES.visibility, { data: { mediaId } });
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
  cache.revalidated.length = 0;
});

afterEach(async () => {
  await afterResponse();
  await Promise.all(itemsMade.splice(0).map((mediaId) => deleteManifest(mediaId).catch(() => {})));
});

describe("POST /api/media/[id]/remove", () => {
  it("hides the browser's own upload from every list at once, uncached, and drops the album's cache", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const mediaId = await addPhoto(guest.id);

    const response = await POST(removeRequest(mediaId), routeContext(mediaId));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ mediaId, removed: true });
    expect(await isVisible(mediaId)).toBe(false);
    expect(await readItem(mediaId)).toMatchObject({ removedByUploader: true, hiddenBy: "guest", hiddenAt: expect.any(Date) });
    expect(cache.revalidated).toEqual([["album-slides", { expire: 0 }]]);
  });

  it("writes the manifest and queues the withdrawal after the response, even once the request's own signal is aborted", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const mediaId = await addPhoto(guest.id);
    const request = new AbortController();

    const response = await POST(removeRequest(mediaId, request.signal), routeContext(mediaId));
    expect(response.status).toBe(200);
    // Next aborts the request's signal once the response is sent, before after()'s tasks run.
    request.abort();
    expect(await visibilityJobs(mediaId)).toEqual([]);
    await afterResponse();

    expect(await readManifest(mediaId)).toMatchObject({ removedByUploader: true, hiddenBy: "guest" });
    expect((await visibilityJobs(mediaId)).map((job) => job.data)).toEqual([{ mediaId, action: "hide" }]);
  });

  it("lets a browser remove an upload of a guest it remembers through a personal link", async () => {
    const own = await createGuest("Kofi Mensah");
    const remembered = await createGuest("Ama Owusu");
    asGuests(own.id, remembered.id);
    const mediaId = await addPhoto(remembered.id);

    expect((await POST(removeRequest(mediaId), routeContext(mediaId))).status).toBe(200);
    expect(await isVisible(mediaId)).toBe(false);
  });

  it("answers the same when asked twice, keeping the first removal's time", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const mediaId = await addPhoto(guest.id);

    expect((await POST(removeRequest(mediaId), routeContext(mediaId))).status).toBe(200);
    const { hiddenAt } = await readItem(mediaId);
    const again = await POST(removeRequest(mediaId), routeContext(mediaId));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ mediaId, removed: true });
    expect((await readItem(mediaId)).hiddenAt).toEqual(hiddenAt);
  });

  it("answers 403 for another guest's upload, changing nothing", async () => {
    const owner = await createGuest("Ama Owusu");
    const stranger = await createGuest("Kofi Mensah");
    asGuests(stranger.id);
    const mediaId = await addPhoto(owner.id);

    const response = await POST(removeRequest(mediaId), routeContext(mediaId));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await isVisible(mediaId)).toBe(true);
    expect(cache.revalidated).toEqual([]);
    await afterResponse();
    expect(await visibilityJobs(mediaId)).toEqual([]);
  });

  it("answers 403 for an item no guest uploaded (a site photo), and to a browser without a guest", async () => {
    const guest = await createGuest("Ama Owusu");
    const sitePhoto = await addPhoto(null);
    const own = await addPhoto(guest.id);

    asGuests(guest.id);
    expect((await POST(removeRequest(sitePhoto), routeContext(sitePhoto))).status).toBe(403);

    browserCookies.clear();
    const withoutGuest = await POST(removeRequest(own), routeContext(own));
    expect(withoutGuest.status).toBe(403);
    expect(await isVisible(own)).toBe(true);
  });

  it("answers 404 for an item that isn't there, or an id that isn't one", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);

    for (const mediaId of [randomUUID(), "not-an-id"]) {
      const response = await POST(removeRequest(mediaId), routeContext(mediaId));
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "not-found" });
    }
    expect(cache.revalidated).toEqual([]);
  });

  it("is limited per guest like a cancel: past the burst it answers 429 with Retry-After", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const mediaId = await addPhoto(guest.id);
    for (let request = 0; request < RATE_LIMITS.complete.burst; request += 1) takeToken(guest.id, "complete");

    const response = await POST(removeRequest(mediaId), routeContext(mediaId));

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await isVisible(mediaId)).toBe(true);
  });
});
