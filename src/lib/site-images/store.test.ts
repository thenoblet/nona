import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { siteImages } from "@/lib/db/schema";
import { resetDb } from "../../../test/db";
import { addSitePhoto } from "../../../test/site-images";
import {
  isLiveSiteImage,
  readAllSiteImages,
  readLiveSiteImage,
  readLiveSiteImages,
  readSiteUpload,
  restoreSiteImage,
  saveSiteImage,
  setCardKey,
} from "./store";

// Against the test database (docker compose up -d db).

const at = (minute: number) => new Date(`2026-11-01T10:${String(minute).padStart(2, "0")}:00Z`);

beforeEach(async () => {
  await resetDb();
});

describe("saving a slot", () => {
  it("makes the newest row per slot the live one, each slot on its own", async () => {
    const first = await addSitePhoto();
    const second = await addSitePhoto();
    await saveSiteImage({ slot: "home-hero", mediaId: first, alt: "The first", focal: { x: 0.5, y: 0.5 }, savedBy: "noblet@example.com" }, at(1));
    const newest = await saveSiteImage(
      { slot: "home-hero", mediaId: second, alt: "  The second  ", focal: { x: 0.36, y: 0.24 }, savedBy: "nancy@example.com" },
      at(2),
    );
    await saveSiteImage({ slot: "landing-cover", mediaId: first, alt: "Cover", focal: { x: 0.5, y: 0.3 }, savedBy: "noblet@example.com" }, at(3));

    const live = await readLiveSiteImages();
    expect(live.map((row) => [row.slot, row.mediaId])).toEqual([
      ["home-hero", second],
      ["landing-cover", first],
    ]);
    expect(live[0]).toMatchObject({ id: newest.id, alt: "The second", focal: { x: 0.36, y: 0.24 }, savedBy: "nancy@example.com" });
    expect(live[0].photo).toMatchObject({ status: "ready", width: 3000, height: 2000 });
    expect(await isLiveSiteImage(newest.id)).toBe(true);
    expect((await readAllSiteImages()).filter((row) => row.slot === "home-hero")).toHaveLength(2);
  });

  it("stores an edit of a built-in photo as a row with no media: the alt text and focal point only", async () => {
    const saved = await saveSiteImage(
      { slot: "story-met-arch", mediaId: null, alt: "Noblet and Nancy, 2019", focal: { x: 0.2, y: 0.8 }, savedBy: "noblet@example.com" },
    );
    expect(saved).toMatchObject({ mediaId: null, alt: "Noblet and Nancy, 2019", focal: { x: 0.2, y: 0.8 }, photo: null });
    expect((await readLiveSiteImage("story-met-arch"))?.id).toBe(saved.id);
  });

  it("refuses empty alt text and a focal point outside the photo, in the database too", async () => {
    const mediaId = await addSitePhoto();
    await expect(
      getDb().insert(siteImages).values({ slot: "home-hero", mediaId, alt: "   ", savedBy: "noblet@example.com" }),
    ).rejects.toThrow();
    await expect(
      getDb().insert(siteImages).values({ slot: "home-hero", mediaId, alt: "Fine", focalX: 1.2, savedBy: "noblet@example.com" }),
    ).rejects.toThrow();
  });

  it("keeps the live row's drawn card when only the alt text changes, and drops it when the photo or focal point does", async () => {
    const mediaId = await addSitePhoto();
    const first = await saveSiteImage({ slot: "preview-album", mediaId, alt: "One", focal: { x: 0.5, y: 0.3 }, savedBy: "a" }, at(1));
    await setCardKey(first.id, "derived/x/0000000000000001/card.jpg");
    const altOnly = await saveSiteImage({ slot: "preview-album", mediaId, alt: "Two", focal: { x: 0.5, y: 0.3 }, savedBy: "a" }, at(2));
    expect(altOnly.cardKey).toBe("derived/x/0000000000000001/card.jpg");
    const moved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "Two", focal: { x: 0.5, y: 0.4 }, savedBy: "a" }, at(3));
    expect(moved.cardKey).toBeNull();
  });
});

describe("restoring an earlier version", () => {
  it("saves it again as the newest, with its photo, words, focal point and card, and the one it replaced stays restorable", async () => {
    const older = await addSitePhoto();
    const newer = await addSitePhoto();
    const first = await saveSiteImage({ slot: "preview-wishes", mediaId: older, alt: "Older", focal: { x: 0.1, y: 0.2 }, savedBy: "a" }, at(1));
    await setCardKey(first.id, "derived/x/00000000000000aa/card.jpg");
    const second = await saveSiteImage({ slot: "preview-wishes", mediaId: newer, alt: "Newer", focal: { x: 0.5, y: 0.5 }, savedBy: "a" }, at(2));
    expect(await isLiveSiteImage(first.id)).toBe(false);

    const restored = await restoreSiteImage(first.id, "nancy@example.com", at(3));
    expect(restored).toMatchObject({
      slot: "preview-wishes",
      mediaId: older,
      alt: "Older",
      focal: { x: 0.1, y: 0.2 },
      cardKey: "derived/x/00000000000000aa/card.jpg",
      savedBy: "nancy@example.com",
    });
    expect((await readLiveSiteImage("preview-wishes"))?.id).toBe(restored?.id);
    expect(await isLiveSiteImage(second.id)).toBe(false);
    expect((await readAllSiteImages()).map((row) => row.id)).toEqual([restored?.id, second.id, first.id]);
  });

  it("does nothing for a row that isn't there", async () => {
    expect(await restoreSiteImage("6f9a3a1e-2c5b-4a8e-9a43-4c1f3b7e0d11", "a")).toBeNull();
    expect(await restoreSiteImage("not-an-id", "a")).toBeNull();
  });
});

describe("readSiteUpload", () => {
  it("reads only the couple's site photos, never a guest's album item, nor one hidden or deleted", async () => {
    const site = await addSitePhoto({ status: "uploaded" });
    const album = await addSitePhoto({ purpose: "album" });
    const hidden = await addSitePhoto({ hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    const deleted = await addSitePhoto({ deletedAt: new Date() });
    expect(await readSiteUpload(site)).toMatchObject({ id: site, status: "uploaded" });
    for (const mediaId of [album, hidden, deleted]) expect(await readSiteUpload(mediaId)).toBeNull();
  });
});
