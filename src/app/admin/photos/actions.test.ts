import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { media, settings, wishes } from "@/lib/db/schema";
import { readSlideshowDelay } from "@/lib/media/slideshow-delay";
import { deleteManifest } from "@/lib/storage/manifest";
import { addAlbumItem } from "../../../../test/album";
import { resetDb } from "../../../../test/db";
import { dropBossSchema, startTestBoss } from "../../../../test/uploads";

// Against the test database and the local MinIO: docker compose up -d db minio && npm run storage:init.

const cache = vi.hoisted(() => ({ refresh: vi.fn(), updateTag: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: cache.refresh, updateTag: cache.updateTag, cacheTag: vi.fn(), cacheLife: vi.fn() }));

// after() runs its task once the action's response is sent: here, when a test says so.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
const nextServer = vi.hoisted(() => ({
  after: vi.fn((task: () => unknown) => {
    afterTasks.push(task);
  }),
}));
vi.mock("next/server", () => ({ after: nextServer.after, connection: async () => {} }));

async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0).map((task) => task()));
}

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

// Task 12's moderation, as it is, watched: each action must call its own function.
vi.mock("@/lib/media/moderation", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/media/moderation")>();
  return {
    ...real,
    hideMedia: vi.fn(real.hideMedia),
    unhideMedia: vi.fn(real.unhideMedia),
    moveMedia: vi.fn(real.moveMedia),
    setHighlight: vi.fn(real.setHighlight),
    retryProcessing: vi.fn(real.retryProcessing),
    deleteMediaPermanently: vi.fn(real.deleteMediaPermanently),
    hideWish: vi.fn(real.hideWish),
    unhideWish: vi.fn(real.unhideWish),
    deleteWishPermanently: vi.fn(real.deleteWishPermanently),
    setUploadsOpen: vi.fn(real.setUploadsOpen),
    setConvertBacklog: vi.fn(real.setConvertBacklog),
  };
});

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

import * as moderation from "@/lib/media/moderation";
import {
  deleteMediaAction,
  deleteWishAction,
  hideMediaAction,
  hideWishAction,
  moveMediaAction,
  resetSlideshowDelayAction,
  retryProcessingAction,
  saveSlideshowDelayAction,
  setConvertBacklogAction,
  setHighlightAction,
  setUploadsOpenAction,
  unhideMediaAction,
  unhideWishAction,
} from "./actions";

const BOSS_SCHEMA = "pgboss_admin_photos_test";
let boss: PgBoss;
const itemsMade: string[] = [];

/** A ready photo, uploaded long enough ago (by default) that its 30-day lock has passed. */
async function photo(overrides: Parameters<typeof addAlbumItem>[0] = {}): Promise<string> {
  const id = await addAlbumItem({ uploadedAt: new Date(Date.now() - 40 * 24 * 3600 * 1000), ...overrides });
  itemsMade.push(id);
  return id;
}

async function textWish(overrides: Partial<typeof wishes.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(wishes)
    .values({ signedAs: "Ama", kind: "text", message: "Congratulations!", ...overrides })
    .returning({ id: wishes.id });
  return row.id;
}

async function readItem(mediaId: string) {
  const [row] = await getDb().select().from(media).where(eq(media.id, mediaId));
  return row;
}

async function readWish(wishId: string) {
  const [row] = await getDb().select().from(wishes).where(eq(wishes.id, wishId));
  return row;
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
  admin.allowed = false;
  afterTasks.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  await afterResponse();
  vi.restoreAllMocks();
  await Promise.all(itemsMade.splice(0).map((mediaId) => deleteManifest(mediaId).catch(() => {})));
});

/** Every action, with arguments it would accept from the couple. */
function everyAction(mediaId: string, wishId: string): [string, () => Promise<unknown>][] {
  return [
    ["hideMediaAction", () => hideMediaAction(mediaId)],
    ["unhideMediaAction", () => unhideMediaAction(mediaId)],
    ["moveMediaAction", () => moveMediaAction(mediaId, "more")],
    ["setHighlightAction", () => setHighlightAction(mediaId, true)],
    ["retryProcessingAction", () => retryProcessingAction(mediaId)],
    ["deleteMediaAction", () => deleteMediaAction(mediaId)],
    ["hideWishAction", () => hideWishAction(wishId)],
    ["unhideWishAction", () => unhideWishAction(wishId)],
    ["deleteWishAction", () => deleteWishAction(wishId)],
    ["setUploadsOpenAction", () => setUploadsOpenAction(false)],
    ["setConvertBacklogAction", () => setConvertBacklogAction(false)],
    ["saveSlideshowDelayAction", () => saveSlideshowDelayAction(60)],
    ["resetSlideshowDelayAction", () => resetSlideshowDelayAction()],
  ];
}

const TASK_12_FUNCTIONS = [
  "hideMedia",
  "unhideMedia",
  "moveMedia",
  "setHighlight",
  "retryProcessing",
  "deleteMediaPermanently",
  "hideWish",
  "unhideWish",
  "deleteWishPermanently",
  "setUploadsOpen",
  "setConvertBacklog",
] as const;

describe("without the couple", () => {
  it("every action throws, calls nothing of Task 12's, and changes nothing", async () => {
    const mediaId = await photo({ status: "failed" });
    const wishId = await textWish();
    await setSetting("uploads_open", true);
    await setSetting("slideshow_delay_seconds", 30);
    const before = { item: await readItem(mediaId), wish: await readWish(wishId), settings: await getDb().select().from(settings) };

    for (const [name, action] of everyAction(mediaId, wishId)) {
      await expect(action(), name).rejects.toThrow("Admin access refused");
    }

    for (const name of TASK_12_FUNCTIONS) expect(moderation[name], name).not.toHaveBeenCalled();
    expect(await readItem(mediaId)).toEqual(before.item);
    expect(await readWish(wishId)).toEqual(before.wish);
    expect(await getDb().select().from(settings)).toEqual(before.settings);
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(afterTasks).toEqual([]);
  });
});

describe("with the couple", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  it("each moderation action calls its Task 12 function with after() and a 30 s budget of its own, never a request's signal", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const mediaId = await photo({ status: "failed" });
    const wishId = await textWish();
    const calls: [string, () => Promise<unknown>, (typeof TASK_12_FUNCTIONS)[number], number][] = [
      ["hide", () => hideMediaAction(mediaId), "hideMedia", 2],
      ["unhide", () => unhideMediaAction(mediaId), "unhideMedia", 2],
      ["move", () => moveMediaAction(mediaId, "more"), "moveMedia", 3],
      ["highlight", () => setHighlightAction(mediaId, true), "setHighlight", 3],
      ["retry", () => retryProcessingAction(mediaId), "retryProcessing", 2],
      ["delete", () => deleteMediaAction(mediaId), "deleteMediaPermanently", 2],
      ["hide wish", () => hideWishAction(wishId), "hideWish", 2],
      ["unhide wish", () => unhideWishAction(wishId), "unhideWish", 2],
      ["delete wish", () => deleteWishAction(wishId), "deleteWishPermanently", 2],
    ];
    for (const [name, action, task12, optionsAt] of calls) {
      timeout.mockClear();
      await action();
      const called = vi.mocked(moderation[task12]);
      expect(called, name).toHaveBeenCalledOnce();
      const options = called.mock.calls[0][optionsAt] as moderation.ModerationOptions;
      // after() itself, so the follow-ups run once the response has gone.
      expect(options.defer, name).toBe(nextServer.after);
      // The signal is a fresh 30-second budget: AbortSignal.timeout's own, live when it is handed over.
      expect(timeout, name).toHaveBeenCalledWith(30_000);
      expect(options.signal, name).toBe(timeout.mock.results.at(-1)?.value);
      expect(options.signal?.aborted, name).toBe(false);
      // The signed-in admin, as requireAdmin named them.
      expect(JSON.stringify(called.mock.calls[0].slice(0, optionsAt)), name).toContain('"couple@example.com"');
      called.mockClear();
      await afterResponse();
    }
  });

  it("refuses an id or a celebration that isn't one before calling anything", async () => {
    const mediaId = await photo();
    for (const result of [
      await hideMediaAction("not-an-id"),
      await unhideMediaAction("1; drop table media"),
      await moveMediaAction(mediaId, "honeymoon"),
      await moveMediaAction(mediaId, 7 as unknown as string),
      await moveMediaAction("not-an-id", "more"),
      await setHighlightAction(mediaId, "yes" as unknown as boolean),
      await retryProcessingAction(""),
      await deleteMediaAction({} as unknown as string),
      await hideWishAction("not-an-id"),
      await unhideWishAction("not-an-id"),
      await deleteWishAction("not-an-id"),
    ]) {
      expect(result).toEqual({ ok: false, error: expect.any(String) });
    }
    for (const name of TASK_12_FUNCTIONS) expect(moderation[name], name).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it("refuses, before calling anything, an id that isn't an album item's: a wish's recording is the Wishes tab's", async () => {
    const recording = await photo({ purpose: "wish", kind: "audio", status: "failed" });
    await textWish({ kind: "voice", message: null, mediaId: recording });
    const before = await readItem(recording);
    for (const result of [
      await hideMediaAction(recording),
      await unhideMediaAction(recording),
      await moveMediaAction(recording, "more"),
      await setHighlightAction(recording, true),
      await retryProcessingAction(recording),
      await deleteMediaAction(recording),
    ]) {
      expect(result).toEqual({ ok: false, error: expect.stringContaining("isn't in the album") });
    }
    for (const name of TASK_12_FUNCTIONS) expect(moderation[name], name).not.toHaveBeenCalled();
    expect(await readItem(recording)).toEqual(before);
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it("answers a highlight that isn't true or false with a reload, not as if the item had gone", async () => {
    const mediaId = await photo();
    expect(await setHighlightAction(mediaId, "yes" as unknown as boolean)).toEqual({ ok: false, error: "Reload the page and try again." });
    expect(moderation.setHighlight).not.toHaveBeenCalled();
  });

  it("hides an item at once, drops the album's and slideshow's cache, and Unhide puts it back", async () => {
    const mediaId = await photo();
    const hidden = await hideMediaAction(mediaId);
    expect(hidden).toMatchObject({ ok: true, item: { id: mediaId, state: "hidden", hiddenBy: "couple@example.com" } });
    expect(await readItem(mediaId)).toMatchObject({ hiddenAt: expect.any(Date), hiddenBy: "couple@example.com" });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(cache.refresh).toHaveBeenCalledOnce();

    cache.updateTag.mockClear();
    cache.refresh.mockClear();
    const back = await unhideMediaAction(mediaId);
    // Processed again, as its public files were withdrawn.
    expect(back).toMatchObject({ ok: true, item: { id: mediaId, state: "processing", hiddenAt: null } });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("moves an item to another celebration, and the album's cache with it", async () => {
    const mediaId = await photo({ celebration: "reception" });
    expect(await moveMediaAction(mediaId, "more")).toMatchObject({ ok: true, item: { celebration: "more" } });
    expect(await readItem(mediaId)).toMatchObject({ celebration: "more", celebrationSetByAdmin: true });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("highlights an item and retries a failed one, which guests don't see change, so the album's cache stays", async () => {
    const mediaId = await photo({ status: "failed", failureReason: "corrupt" });
    expect(await setHighlightAction(mediaId, true)).toMatchObject({ ok: true, item: { highlight: true } });
    expect(await retryProcessingAction(mediaId)).toMatchObject({ ok: true, item: { state: "processing", failure: null } });
    expect(await retryProcessingAction(mediaId)).toEqual({ ok: false, error: expect.stringContaining("nothing to retry") });
    expect(await setHighlightAction(mediaId, false)).toMatchObject({ ok: true, item: { highlight: false } });
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).toHaveBeenCalledTimes(4);
  });

  it("says when an item may be deleted, and leaves it, until its 30-day lock has passed", async () => {
    const uploadedAt = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    const locked = await photo({ uploadedAt });
    const result = await deleteMediaAction(locked);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/^Can be deleted permanently from /) });
    expect(await readItem(locked)).toMatchObject({ deletedAt: null, uploaderName: "Ama Owusu" });
    expect(cache.updateTag).not.toHaveBeenCalled();

    const old = await photo();
    expect(await deleteMediaAction(old)).toEqual({ ok: true, item: null });
    expect(await readItem(old)).toMatchObject({ deletedAt: expect.any(Date), uploaderName: null });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(await deleteMediaAction(randomUUID())).toEqual({ ok: false, error: expect.any(String) });
  });

  it("hides, unhides and deletes a written wish", async () => {
    const wishId = await textWish();
    expect(await hideWishAction(wishId)).toMatchObject({ ok: true, wish: { id: wishId, hiddenBy: "couple@example.com" } });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(await unhideWishAction(wishId)).toMatchObject({ ok: true, wish: { id: wishId, hiddenAt: null } });
    expect(await deleteWishAction(wishId)).toEqual({ ok: true, wish: null });
    expect(await readWish(wishId)).toMatchObject({ deletedAt: expect.any(Date), signedAs: "deleted", message: "" });
    expect(await hideWishAction(randomUUID())).toEqual({ ok: false, error: expect.any(String) });
    expect(cache.refresh).toHaveBeenCalledTimes(4);
  });

  it("says so when a recorded wish's recording never finished uploading, rather than that the wish is gone", async () => {
    const recording = await addAlbumItem({ purpose: "wish", kind: "audio", status: "uploading", uploadedAt: null });
    const wishId = await textWish({ kind: "voice", message: null, mediaId: recording, createdAt: new Date(Date.now() - 40 * 24 * 3600 * 1000) });
    expect(await deleteWishAction(wishId)).toEqual({ ok: false, error: expect.stringMatching(/^Its recording never finished uploading/) });
    expect(await readWish(wishId)).toMatchObject({ deletedAt: null, signedAs: "Ama" });
  });

  it("closes and opens uploads, and switches the backlog conversions, refusing anything but true or false", async () => {
    await setSetting("uploads_open", true);
    expect(await setUploadsOpenAction(false)).toEqual({ ok: true, changed: true });
    expect(await getSetting("uploads_open", true)).toBe(false);
    expect(await getSetting("uploads_closed_at", null)).toEqual(expect.any(String));
    expect(await setUploadsOpenAction(true)).toEqual({ ok: true, changed: true });
    expect(await getSetting("uploads_open", false)).toBe(true);

    expect(await setConvertBacklogAction(false)).toEqual({ ok: true, changed: true });
    expect(await getSetting("convert_backlog", true)).toBe(false);
    expect(await setConvertBacklogAction(true)).toEqual({ ok: true, changed: true });
    expect(await getSetting("convert_backlog", false)).toBe(true);
    expect(moderation.setUploadsOpen).toHaveBeenCalledWith(false, "couple@example.com");
    expect(moderation.setConvertBacklog).toHaveBeenCalledWith(false, "couple@example.com");
    expect(cache.refresh).toHaveBeenCalledTimes(4);

    for (const value of ["false", 0, null, undefined]) {
      expect(await setUploadsOpenAction(value as unknown as boolean)).toEqual({ ok: false, error: expect.any(String) });
      expect(await setConvertBacklogAction(value as unknown as boolean)).toEqual({ ok: false, error: expect.any(String) });
    }
    expect(await getSetting("uploads_open", false)).toBe(true);
  });

  it("says when a switch already stood where a page that loaded earlier asks it to go", async () => {
    // The other admin closed uploads and paused the backlog after this page loaded.
    await setSetting("uploads_open", false);
    await setSetting("convert_backlog", false);
    expect(await setUploadsOpenAction(false)).toEqual({ ok: true, changed: false });
    expect(await setConvertBacklogAction(false)).toEqual({ ok: true, changed: false });
    expect(await getSetting("uploads_open", true)).toBe(false);
    expect(await getSetting("convert_backlog", true)).toBe(false);
    expect(cache.refresh).toHaveBeenCalledTimes(2);
  });

  it("goes back to the default TV delay, which the slideshow's cache then drops, and logs each change without the admin's email", async () => {
    vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "240");
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await saveSlideshowDelayAction(60)).toEqual({ ok: true });
    expect(await readSlideshowDelay()).toEqual({ seconds: 60, saved: true, defaultSeconds: 240 });
    cache.updateTag.mockClear();
    cache.refresh.mockClear();

    expect(await resetSlideshowDelayAction()).toEqual({ ok: true });
    expect(await getSetting("slideshow_delay_seconds", null)).toBeNull();
    expect(await getDb().select().from(settings).where(eq(settings.key, "slideshow_delay_seconds"))).toEqual([]);
    expect(await readSlideshowDelay()).toEqual({ seconds: 240, saved: false, defaultSeconds: 240 });
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(cache.refresh).toHaveBeenCalledOnce();

    const lines = logged.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("TV delay"));
    expect(lines).toEqual(["[moderation] TV delay set to 60 s by an admin", "[moderation] TV delay reset to the default by an admin"]);
    vi.unstubAllEnvs();
  });

  it("saves the TV delay from 0 to 900 seconds, which the slideshow's cache then drops, and refuses anything else", async () => {
    for (const wrong of [-1, 901, 1.5, Number.NaN, "180", null]) {
      expect(await saveSlideshowDelayAction(wrong as unknown as number)).toEqual({ ok: false, error: expect.any(String) });
    }
    expect(await getSetting("slideshow_delay_seconds", null)).toBeNull();
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();

    expect(await saveSlideshowDelayAction(0)).toEqual({ ok: true });
    expect(await getSetting("slideshow_delay_seconds", null)).toBe(0);
    expect(await saveSlideshowDelayAction(900)).toEqual({ ok: true });
    expect(await getSetting("slideshow_delay_seconds", null)).toBe(900);
    expect(cache.updateTag).toHaveBeenCalledWith("album-slides");
    expect(cache.updateTag).toHaveBeenCalledTimes(2);
    expect(cache.refresh).toHaveBeenCalledTimes(2);
  });
});
