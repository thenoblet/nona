import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { builtinFocal, builtinPhoto } from "@/lib/site-images/photos";
import { readAllSiteImages, setCardKey } from "@/lib/site-images/store";
import { resetDb } from "../../../../../test/db";
import { addSitePhoto, readLiveSiteImage } from "../../../../../test/site-images";
import { dropBossSchema, startTestBoss } from "../../../../../test/uploads";

// Against the test database (docker compose up -d db).

const cache = vi.hoisted(() => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock("next/cache", () => ({ updateTag: cache.updateTag, refresh: cache.refresh, cacheTag: vi.fn(), cacheLife: vi.fn() }));

// after() runs its task once the action's response is sent: here, when a test says so.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({ after: (task: () => unknown) => void afterTasks.push(task), connection: async () => {} }));

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

import { restoreSlotAction, saveSlotAction, slotStateAction } from "./actions";

const BOSS_SCHEMA = "pgboss_site_photos_test";
let boss: PgBoss;

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
});

afterAll(async () => {
  await boss.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
});

beforeEach(async () => {
  await resetDb();
  await boss.deleteAllJobs(MEDIA_QUEUES.card);
  afterTasks.length = 0;
  admin.allowed = true;
  cache.updateTag.mockClear();
});

/** The media.card jobs waiting, by their data. */
async function cardJobs(): Promise<unknown[]> {
  const jobs = await boss.findJobs(MEDIA_QUEUES.card);
  return jobs.filter((job) => job.state === "created").map((job) => job.data);
}

describe("saveSlotAction", () => {
  it("refuses anyone but the couple, saving nothing", async () => {
    admin.allowed = false;
    const mediaId = await addSitePhoto();
    await expect(saveSlotAction({ slot: "home-hero", mediaId, alt: "Us", focal: { x: 0.5, y: 0.5 } })).rejects.toThrow(
      "Admin access refused",
    );
    expect(await readAllSiteImages()).toEqual([]);
  });

  it("saves the couple's photo with its alt text and focal point, live on the guest pages at once", async () => {
    const mediaId = await addSitePhoto();
    const result = await saveSlotAction({ slot: "home-hero", mediaId, alt: "  Noblet and Nancy at the lake ", focal: { x: 0.36, y: 0.24 } });
    expect(result).toMatchObject({ ok: true, slot: { id: "home-hero", state: "yours", alt: "Noblet and Nancy at the lake", focal: { x: 0.36, y: 0.24 } } });
    expect(await readLiveSiteImage("home-hero")).toMatchObject({ mediaId, alt: "Noblet and Nancy at the lake", savedBy: "couple@example.com" });
    expect(cache.updateTag).toHaveBeenCalledWith("site-images");
    // Not a preview slot: no card to draw.
    await afterResponse();
    expect(await cardJobs()).toEqual([]);
  });

  it("requires alt text, and saves nothing without it", async () => {
    const mediaId = await addSitePhoto();
    expect(await saveSlotAction({ slot: "home-hero", mediaId, alt: "   ", focal: { x: 0.5, y: 0.5 } })).toEqual({
      ok: false,
      field: "alt",
      error: "Describe the photo before saving.",
    });
    expect(await saveSlotAction({ slot: "home-hero", mediaId, alt: "x".repeat(301), focal: { x: 0.5, y: 0.5 } })).toMatchObject({
      ok: false,
      field: "alt",
    });
    expect(await readAllSiteImages()).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
  });

  it("refuses a slot, focal point or photo that isn't one", async () => {
    const mediaId = await addSitePhoto();
    const albumItem = await addSitePhoto({ purpose: "album" });
    const processing = await addSitePhoto({ status: "uploaded" });
    const refusals = [
      { slot: "nope", mediaId, alt: "Us", focal: { x: 0.5, y: 0.5 } },
      { slot: "home-hero", mediaId, alt: "Us", focal: { x: 1.5, y: 0.5 } },
      { slot: "home-hero", mediaId: albumItem, alt: "Us", focal: { x: 0.5, y: 0.5 } },
      { slot: "home-hero", mediaId: processing, alt: "Us", focal: { x: 0.5, y: 0.5 } },
      { slot: "home-hero", mediaId: "not-an-id", alt: "Us", focal: { x: 0.5, y: 0.5 } },
    ];
    for (const input of refusals) expect((await saveSlotAction(input)).ok, JSON.stringify(input)).toBe(false);
    expect(await readAllSiteImages()).toEqual([]);
  });

  it("edits a built-in photo's alt text and focal point with no new upload; a slot with no built-in photo needs one", async () => {
    const result = await saveSlotAction({ slot: "story-met-arch", mediaId: null, alt: "Us, 2019", focal: { x: 0.2, y: 0.7 } });
    expect(result).toMatchObject({ ok: true, slot: { state: "builtin", edited: true, alt: "Us, 2019", focal: { x: 0.2, y: 0.7 } } });
    expect(await readLiveSiteImage("story-met-arch")).toMatchObject({ mediaId: null, alt: "Us, 2019", focal: { x: 0.2, y: 0.7 } });

    expect(await saveSlotAction({ slot: "party-bernice", mediaId: null, alt: "Bernice", focal: { x: 0.5, y: 0.5 } })).toMatchObject({
      ok: false,
    });
  });

  it("sends the preview slot's card to the worker after the response, by the row's id only", async () => {
    const mediaId = await addSitePhoto();
    const result = await saveSlotAction({ slot: "preview-album", mediaId, alt: "A kiss", focal: { x: 0.5, y: 0.3 } });
    if (!result.ok) throw new Error(result.error);
    expect(result.slot.card).toMatchObject({ drawn: false });
    expect(await cardJobs()).toEqual([]);
    await afterResponse();
    const live = await readLiveSiteImage("preview-album");
    expect(await cardJobs()).toEqual([{ siteImageId: live?.id }]);
  });

  it("sends a card for a built-in preview photo's new focal point too", async () => {
    await saveSlotAction({ slot: "preview-wishes", mediaId: null, alt: "Nancy smiling", focal: { x: 0.5, y: 0.1 } });
    await afterResponse();
    expect(await cardJobs()).toHaveLength(1);
  });
});

describe("restoreSlotAction", () => {
  it("makes an earlier version live again, and the built-in photo too", async () => {
    const older = await addSitePhoto();
    const newer = await addSitePhoto();
    await saveSlotAction({ slot: "landing-cover", mediaId: older, alt: "Older", focal: { x: 0.1, y: 0.2 } });
    const olderRow = await readLiveSiteImage("landing-cover");
    await saveSlotAction({ slot: "landing-cover", mediaId: newer, alt: "Newer", focal: { x: 0.5, y: 0.5 } });
    cache.updateTag.mockClear();

    const restored = await restoreSlotAction("landing-cover", olderRow!.id);
    expect(restored).toMatchObject({ ok: true, slot: { state: "yours", alt: "Older", focal: { x: 0.1, y: 0.2 } } });
    expect(await readLiveSiteImage("landing-cover")).toMatchObject({ mediaId: older, alt: "Older" });
    expect(cache.updateTag).toHaveBeenCalledWith("site-images");

    const builtin = await restoreSlotAction("landing-cover", "builtin");
    expect(builtin).toMatchObject({ ok: true, slot: { state: "builtin", edited: false } });
    // The built-in photo's own focal point, whichever photo that is.
    expect(await readLiveSiteImage("landing-cover")).toMatchObject({ mediaId: null, focal: builtinFocal(builtinPhoto("landing-cover")!) });
  });

  it("refuses another slot's version, and the built-in photo of a slot that has none", async () => {
    const mediaId = await addSitePhoto();
    await saveSlotAction({ slot: "landing-cover", mediaId, alt: "Cover", focal: { x: 0.5, y: 0.5 } });
    const cover = await readLiveSiteImage("landing-cover");
    expect(await restoreSlotAction("landing-print", cover!.id)).toMatchObject({ ok: false });
    expect(await restoreSlotAction("party-bernice", "builtin")).toMatchObject({ ok: false });
  });

  it("refuses anyone but the couple", async () => {
    admin.allowed = false;
    await expect(restoreSlotAction("landing-cover", "builtin")).rejects.toThrow("Admin access refused");
  });

  it("sends a restored preview slot's card to the worker", async () => {
    const mediaId = await addSitePhoto();
    await saveSlotAction({ slot: "preview-rsvp", mediaId, alt: "Bouquet", focal: { x: 0.5, y: 0.2 } });
    const first = await readLiveSiteImage("preview-rsvp");
    await saveSlotAction({ slot: "preview-rsvp", mediaId, alt: "Bouquet", focal: { x: 0.5, y: 0.6 } });
    await afterResponse();
    await restoreSlotAction("preview-rsvp", first!.id);
    await afterResponse();
    const live = await readLiveSiteImage("preview-rsvp");
    expect(await cardJobs()).toContainEqual({ siteImageId: live?.id });
  });
});

describe("slotStateAction", () => {
  it("tells the admin when the worker has drawn the card, and updates the guest pages' cache then", async () => {
    const mediaId = await addSitePhoto();
    await saveSlotAction({ slot: "preview-album", mediaId, alt: "A kiss", focal: { x: 0.5, y: 0.3 } });
    cache.updateTag.mockClear();
    expect(await slotStateAction("preview-album")).toMatchObject({ ok: true, slot: { card: { drawn: false } } });
    expect(cache.updateTag).not.toHaveBeenCalled();

    const live = await readLiveSiteImage("preview-album");
    await setCardKey(live!.id, `derived/${mediaId}/0011223344556677/card.jpg`);
    const drawn = await slotStateAction("preview-album");
    expect(drawn).toMatchObject({ ok: true, slot: { card: { drawn: true } } });
    if (drawn.ok) expect(drawn.slot.card?.url).toContain(`/derived/${mediaId}/0011223344556677/card.jpg`);
    expect(cache.updateTag).toHaveBeenCalledWith("site-images");
  });

  it("refuses anyone but the couple", async () => {
    admin.allowed = false;
    await expect(slotStateAction("preview-album")).rejects.toThrow("Admin access refused");
  });
});
