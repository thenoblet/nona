import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { mediaBaseUrl } from "@/lib/env";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { RATE_LIMITS } from "@/lib/guests/rate-limit";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../../../../../test/db";
import { browserCookies } from "../../../../../../test/next-cookies";
import { dropBossSchema, jsonRequest, routeContext, startTestBoss } from "../../../../../../test/uploads";

// These run against the test database: docker compose up -d db.

vi.mock("next/headers", () => import("../../../../../../test/next-cookies"));

// after() runs its task once the response is sent: here, only when the test says the response is
// done, so a test can see what was sent before and after.
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

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { POST } from "./route";

const BOSS_SCHEMA = "pgboss_playable_test";
let boss: PgBoss;

/** The guest this browser is (the default cookie jar). */
async function signIn(displayName = "Ama Owusu") {
  const guest = await createGuest(displayName);
  browserCookies.values.set(guestCookieName(), signGuestIds([guest.id]));
  return guest;
}

/** A video's row as the poster job leaves one no phone's browser can play: ready, listed, its conversion queued. */
async function addVideo(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "video",
      guestId: null,
      uploaderName: "Kofi Mensah",
      celebration: "reception",
      originalKey: originalKey(id, "mov"),
      originalFilename: "IMG_0001.MOV",
      sizeBytes: 50_000_000,
      contentType: "video/quicktime",
      status: "ready",
      listedAt: new Date("2026-12-06T12:00:00Z"),
      derived: { "poster-view": `derived/${id}/0000000000000000/poster-view.webp` },
      videoCodec: "hevc",
      browserPlayable: false,
      conversion: "queued",
      ...values,
    });
  return id;
}

function askFor(mediaId: string) {
  return POST(jsonRequest(`/api/media/${mediaId}/playable`, "POST"), routeContext(mediaId));
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

/** The media.convert jobs sent for an item. */
async function conversionJobs(mediaId: string) {
  return boss.findJobs<{ mediaId: string }>(MEDIA_QUEUES.convert, { data: { mediaId } });
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
  await boss.deleteAllJobs(MEDIA_QUEUES.convert);
  browserCookies.clear();
  afterTasks.length = 0;
  queue.sendFails = false;
});

afterEach(async () => {
  await afterResponse();
  vi.restoreAllMocks();
});

describe("POST /api/media/[id]/playable", () => {
  it("answers a converted video with its MP4's public URL, uncached, and sends nothing", async () => {
    await signIn();
    const videoKey = `derived/${randomUUID()}/0123456789abcdef/video.mp4`;
    const mediaId = await addVideo({ conversion: "done", derived: { video: videoKey } });

    const response = await askFor(mediaId);
    await afterResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ status: "ready", url: `${mediaBaseUrl()}/${videoKey}` });
    expect(await conversionJobs(mediaId)).toEqual([]);
  });

  it("asks for a conversion on demand: marks when it was asked, and sends one job at priority 20, after the response", async () => {
    await signIn();
    const mediaId = await addVideo();
    // The poster job's backlog job may wait for it already, held by the switch: it stays.
    await boss.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.backlog });

    const response = await askFor(mediaId);
    // Only the backlog's job until the response has gone: the send waits for after().
    expect(await conversionJobs(mediaId)).toHaveLength(1);
    await afterResponse();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ status: "preparing" });
    expect((await readItem(mediaId)).conversionRequestedAt).toBeInstanceOf(Date);
    expect((await conversionJobs(mediaId)).map((job) => job.priority).sort((first, second) => first - second)).toEqual([
      CONVERT_PRIORITY.backlog,
      CONVERT_PRIORITY.onDemand,
    ]);
  });

  it("never queues a second on-demand job, however often (or at once) it is asked: the row is the guard", async () => {
    await signIn();
    const mediaId = await addVideo();

    for (let request = 0; request < 3; request += 1) {
      const [first, second] = await Promise.all([askFor(mediaId), askFor(mediaId)]);
      expect(await first.json()).toEqual({ status: "preparing" });
      expect(await second.json()).toEqual({ status: "preparing" });
    }
    await afterResponse();

    expect(await conversionJobs(mediaId)).toEqual([expect.objectContaining({ priority: CONVERT_PRIORITY.onDemand })]);
  });

  it("records the first ask for a conversion the backlog is running, so it goes on demand should that one fail and wait again", async () => {
    await signIn();
    const mediaId = await addVideo({ conversion: "converting" });

    expect(await (await askFor(mediaId)).json()).toEqual({ status: "preparing" });
    expect(await (await askFor(mediaId)).json()).toEqual({ status: "preparing" });
    await afterResponse();

    expect(await readItem(mediaId)).toMatchObject({ conversion: "converting", conversionRequestedAt: expect.any(Date) });
    // Sent once: it does nothing while the backlog's runs (a first attempt never takes a running conversion).
    expect(await conversionJobs(mediaId)).toEqual([expect.objectContaining({ priority: CONVERT_PRIORITY.onDemand })]);
  });

  it("queues a video that needed no conversion when a phone still can't play it", async () => {
    await signIn();
    const mediaId = await addVideo({ conversion: "none", browserPlayable: true, videoCodec: "h264" });

    expect(await (await askFor(mediaId)).json()).toEqual({ status: "preparing" });
    await afterResponse();

    expect(await readItem(mediaId)).toMatchObject({ conversion: "queued" });
    expect(await conversionJobs(mediaId)).toEqual([expect.objectContaining({ priority: CONVERT_PRIORITY.onDemand })]);
  });

  it("says a conversion that failed for good has failed, and why, and sends nothing: there is no version to wait for", async () => {
    await signIn();
    const tooLong = await addVideo({ conversion: "failed", conversionFailureReason: "too-long" });
    const corrupt = await addVideo({ conversion: "failed", conversionFailureReason: "corrupt" });
    const noReason = await addVideo({ conversion: "failed" });

    expect(await (await askFor(tooLong)).json()).toEqual({ status: "failed", reason: "too-long" });
    expect(await (await askFor(corrupt)).json()).toEqual({ status: "failed", reason: "corrupt" });
    expect(await (await askFor(noReason)).json()).toEqual({ status: "failed", reason: "conversion-failed" });
    await afterResponse();

    for (const mediaId of [tooLong, corrupt, noReason]) expect(await conversionJobs(mediaId)).toEqual([]);
  });

  it("answers preparing though the job couldn't be sent: the sweeper sends it from the row, at priority 20", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await signIn();
    queue.sendFails = true;
    const mediaId = await addVideo();

    expect(await (await askFor(mediaId)).json()).toEqual({ status: "preparing" });
    await afterResponse();

    expect(await readItem(mediaId)).toMatchObject({ conversion: "queued", conversionRequestedAt: expect.any(Date) });
    expect(errors.mock.calls.flat().join(" ")).toContain(`could not send ${mediaId}'s conversion on demand; the sweeper will`);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("The job queue is down");
  });

  it("answers 404 for a video that is hidden, removed by its uploader, deleted, not ready, a photo, a wish, or not there", async () => {
    await signIn();
    const items = [
      await addVideo({ hiddenAt: new Date(), hiddenBy: "admin" }),
      await addVideo({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addVideo({ deletedAt: new Date() }),
      await addVideo({ conversion: "done", derived: { video: "derived/x/0123456789abcdef/video.mp4" }, hiddenAt: new Date(), hiddenBy: "admin" }),
      await addVideo({ status: "uploaded", listedAt: null, conversion: "none" }),
      await addVideo({ status: "failed", failureReason: "corrupt", conversion: "none" }),
      await addVideo({ kind: "photo", contentType: "image/jpeg", conversion: "none" }),
      await addVideo({ purpose: "wish" }),
    ];

    for (const mediaId of [...items, randomUUID(), "not-an-id"]) {
      const response = await askFor(mediaId);
      expect(response.status, mediaId).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: "not-found" });
    }
    await afterResponse();
    for (const mediaId of items) {
      expect(await conversionJobs(mediaId)).toEqual([]);
      expect((await readItem(mediaId)).conversionRequestedAt).toBeNull();
    }
  });

  it("answers 403 to a browser with no guest (or a forged cookie), and touches nothing", async () => {
    const mediaId = await addVideo();
    const noGuest = await askFor(mediaId);
    browserCookies.values.set(guestCookieName(), `${randomUUID()}.forged`);
    const forged = await askFor(mediaId);
    await afterResponse();

    for (const response of [noGuest, forged]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect((await readItem(mediaId)).conversionRequestedAt).toBeNull();
    expect(await conversionJobs(mediaId)).toEqual([]);
  });

  it("lets a guest start 10 conversions, then one a minute, with Retry-After: asking again for one started spends nothing", async () => {
    await signIn();
    const { burst } = RATE_LIMITS.conversion;
    expect(RATE_LIMITS.conversion).toEqual({ burst: 10, refillEveryMs: 60_000 });
    const videos = await Promise.all(Array.from({ length: burst + 1 }, () => addVideo()));

    for (const mediaId of videos.slice(0, burst)) {
      expect(await (await askFor(mediaId)).json()).toEqual({ status: "preparing" });
    }
    const limited = await askFor(videos[burst]);
    // Asking again for one already started, or for one converted, takes nothing from the bucket.
    const again = await askFor(videos[0]);
    await afterResponse();

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(30);
    expect(limited.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await again.json()).toEqual({ status: "preparing" });
    expect((await readItem(videos[burst])).conversionRequestedAt).toBeNull();
    expect(await conversionJobs(videos[burst])).toEqual([]);
    // Another guest has a bucket of their own.
    await signIn("Kofi");
    expect(await (await askFor(videos[burst])).json()).toEqual({ status: "preparing" });
  });

  it("limits each guest by their own playable bucket (100, then 2 a second), with Retry-After", async () => {
    await signIn();
    const mediaId = await addVideo({ conversion: "done", derived: { video: "derived/x/0123456789abcdef/video.mp4" } });
    const { burst } = RATE_LIMITS.playable;

    const answers = await Promise.all(Array.from({ length: burst }, () => askFor(mediaId)));
    expect(answers.every((response) => response.status === 200)).toBe(true);
    const limited = await askFor(mediaId);

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // Another guest is untouched: limits are per guest, never per address.
    await signIn("Kofi");
    expect((await askFor(mediaId)).status).toBe(200);
  });
});
