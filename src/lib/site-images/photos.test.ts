import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { TEST_STORAGE_ENV } from "../../../test/env";
import { resetDb } from "../../../test/db";
import { addSitePhoto } from "../../../test/site-images";

// Against the test database (docker compose up -d db). The cache is Next's: here every read is fresh.
vi.mock("next/cache", () => ({ cacheTag: vi.fn(), cacheLife: vi.fn() }));

import { SitePhoto } from "@/components/ui/SitePhoto";
import { getSiteImages, storedCardImages } from "./get";
import { builtinPhoto, slotPhotos } from "./photos";
import { saveSiteImage, setCardKey } from "./store";

const media = TEST_STORAGE_ENV.MEDIA_BASE_URL;

beforeEach(async () => {
  await resetDb();
});

describe("what a guest page shows in a slot", () => {
  it("is the built-in photo until the couple save one", async () => {
    // Ama: someone the couple add to the wedding party in the admin, so with no built-in portrait.
    const party = [...contentDefaults.party, { id: "ama", name: "Ama", role: "Bridesmaid" }];
    const photos = slotPhotos(await getSiteImages(), party);
    expect(photos["landing-cover"]).toMatchObject({ kind: "builtin", alt: builtinPhoto("landing-cover")?.alt });
    expect(photos["story-met-arch"]?.kind).toBe("builtin");
    // The pre-wedding shoot behind the hero; nothing for a member with no portrait yet.
    expect(photos["home-hero"]).toMatchObject({ kind: "builtin", alt: builtinPhoto("home-hero")?.alt });
    expect(photos["party-ama"]).toBeNull();
    expect(photos["party-lilian"]?.kind).toBe("builtin");
  });

  it("replaces the default with the saved photo, from the worker's sizes on the media domain, its focal point the object-position", async () => {
    const mediaId = await addSitePhoto({ width: 6000, height: 4000 });
    await saveSiteImage({ slot: "home-hero", mediaId, alt: "Noblet and Nancy at Lake Bosomtwe", focal: { x: 0.36, y: 0.24 }, savedBy: "a" });
    await saveSiteImage({ slot: "story-met-print", mediaId, alt: "A print", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });

    const photos = slotPhotos(await getSiteImages(), contentDefaults.party);
    const hero = photos["home-hero"];
    expect(hero).toMatchObject({ kind: "uploaded", alt: "Noblet and Nancy at Lake Bosomtwe", position: "36% 24%", width: 6000, height: 4000 });
    if (hero?.kind !== "uploaded") throw new Error("expected the couple's photo");
    // The hero is full width: every size, up to 2400 px.
    expect(hero.sources.map((source) => source.width)).toEqual([480, 960, 1600, 2400]);
    for (const source of hero.sources) expect(source.url.startsWith(`${media}/derived/${mediaId}/`)).toBe(true);
    // A 120 px print lists only the thumbnail.
    const print = photos["story-met-print"];
    expect(print?.kind === "uploaded" && print.sources.map((source) => source.width)).toEqual([480]);
    // The other slots keep their built-in photos.
    expect(photos["landing-cover"]?.kind).toBe("builtin");

    const html = renderToStaticMarkup(createElement(SitePhoto, { photo: hero, fill: true, priority: true, sizes: "100vw", className: "object-cover" }));
    expect(html).toContain(`src="${media}/derived/${mediaId}/fedcba9876543210/large.webp"`);
    expect(html).toContain(`${media}/derived/${mediaId}/fedcba9876543210/medium.webp 960w`);
    expect(html).toContain('sizes="100vw"');
    expect(html).toContain('width="6000"');
    expect(html).toContain('height="4000"');
    expect(html).toContain("object-position:36% 24%");
    expect(html).toContain('alt="Noblet and Nancy at Lake Bosomtwe"');
    // Never through Next's image optimiser.
    expect(html).not.toContain("/_next/image");
  });

  it("applies an edit of a built-in photo's alt text and focal point to the built-in photo", async () => {
    await saveSiteImage({ slot: "landing-cover", mediaId: null, alt: "Our proposal, in black and white", focal: { x: 0.4, y: 0.6 }, savedBy: "a" });
    const photos = slotPhotos(await getSiteImages(), contentDefaults.party);
    expect(photos["landing-cover"]).toMatchObject({
      kind: "builtin",
      image: builtinPhoto("landing-cover")?.image,
      alt: "Our proposal, in black and white",
      position: "40% 60%",
    });
  });

  it("never shows a photo that was hidden or deleted: the slot falls back to its built-in one", async () => {
    const hidden = await addSitePhoto({ hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    const deleted = await addSitePhoto({ deletedAt: new Date() });
    await saveSiteImage({ slot: "story-met-arch", mediaId: hidden, alt: "Hidden", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    await saveSiteImage({ slot: "gallery-left", mediaId: deleted, alt: "Deleted", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    const photos = slotPhotos(await getSiteImages(), contentDefaults.party);
    expect(photos["story-met-arch"]?.kind).toBe("builtin");
    expect(photos["gallery-left"]?.kind).toBe("builtin");
  });

  it("keeps the built-in photo while a saved photo isn't ready to show", async () => {
    const mediaId = await addSitePhoto({ status: "uploaded" });
    await saveSiteImage({ slot: "story-met-arch", mediaId, alt: "Not yet", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    expect(slotPhotos(await getSiteImages(), contentDefaults.party)["story-met-arch"]?.kind).toBe("builtin");
  });
});

describe("a page's preview card", () => {
  it("points og:image at the worker's card once it is drawn, and leaves the build-time card alone until then", async () => {
    const mediaId = await addSitePhoto();
    const saved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "A kiss", focal: { x: 0.5, y: 0.3 }, savedBy: "a" });
    expect(storedCardImages(await getSiteImages(), "album")).toEqual({});

    await setCardKey(saved.id, `derived/${mediaId}/0011223344556677/card.jpg`);
    expect(storedCardImages(await getSiteImages(), "album")).toEqual({
      images: [
        {
          url: `${media}/derived/${mediaId}/0011223344556677/card.jpg`,
          width: 1200,
          height: 630,
          alt: "Share your photos and videos in Noblet and Nancy's wedding album",
          type: "image/jpeg",
        },
      ],
    });
    expect(storedCardImages(await getSiteImages(), "wishes")).toEqual({});
  });
});
