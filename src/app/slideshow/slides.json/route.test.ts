import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { setSetting } from "@/lib/data/settings";
import { hideMedia } from "@/lib/media/moderation";
import { publicUrl } from "@/lib/storage/keys";
import type { Slide } from "@/components/slideshow/playlist";
import { addAlbumItem, photoKeys, posterKeys } from "../../../../test/album";
import { resetDb } from "../../../../test/db";

// Against the test database (docker compose up -d db). Outside Next, "use cache" does nothing, so
// every request here reads afresh: these check what a fresh read holds, and what the cache is told
// (its lifetime and tag). That a hide reaches a cached list at once is checked against the
// production build (e2e/slideshow.spec.ts).

vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

const cache = vi.hoisted(() => ({ tags: [] as string[], lives: [] as unknown[] }));
vi.mock("next/cache", () => ({
  cacheTag: (...tags: string[]) => {
    cache.tags.push(...tags);
  },
  cacheLife: (profile: unknown) => {
    cache.lives.push(profile);
  },
}));

// A read that fails, when a test asks for one.
const reads = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/lib/media/slideshow", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/media/slideshow")>();
  return {
    ...real,
    listSlideshowItems: async (delaySeconds: number) => {
      if (reads.failNext) {
        reads.failNext = false;
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      }
      return real.listSlideshowItems(delaySeconds);
    },
  };
});

import { GET } from "./route";


async function slides(): Promise<Slide[]> {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()).slides;
}

const idsOf = async () => (await slides()).map((slide) => slide.id);

beforeEach(async () => {
  await resetDb();
  cache.tags.length = 0;
  cache.lives.length = 0;
  reads.failNext = false;
  vi.stubEnv("SLIDESHOW_DELAY_SECONDS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /slideshow/slides.json", () => {
  it("answers the album's moments past the TV delay, newest first, at their viewing size, with who shared them and when", async () => {
    const photo = await addAlbumItem({ uploaderName: "Kojo Antwi", width: 1600, height: 1200, listedSecondsAgo: 12 * 60 + 5 });
    const videoId = randomUUID();
    await addAlbumItem({
      id: videoId,
      kind: "video",
      uploaderName: "Efua Asante",
      celebration: "ceremony",
      derived: posterKeys(videoId),
      width: 720,
      height: 1280,
      listedSecondsAgo: 5 * 60 + 5,
    });

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const { slides: answered } = (await response.json()) as { slides: Slide[] };
    expect(answered).toEqual([
      {
        id: videoId,
        kind: "video",
        src: publicUrl(posterKeys(videoId)["poster-view"]),
        width: 720,
        height: 1280,
        by: "Efua Asante",
        // The celebration as the site names it, and how long ago by the request's clock: the newest
        // moment is five minutes old, not "just now".
        detail: "White wedding · 5 min ago",
      },
      {
        id: photo,
        kind: "photo",
        src: publicUrl(photoKeys(photo).view),
        width: 1600,
        height: 1200,
        by: "Kojo Antwi",
        detail: "Reception · 12 min ago",
      },
    ]);
  });

  it("says hours, then the day, for older moments, and names the More moments of other days", async () => {
    await addAlbumItem({ celebration: "reception", listedSecondsAgo: 3 * 3600 + 60 });
    await addAlbumItem({ celebration: "more", listedAtText: "2026-10-28 10:00:00+00" });
    expect((await slides()).map((slide) => slide.detail)).toEqual(["Reception · 3 h ago", "More moments · 28 Oct"]);
  });

  it("names no one for a moment shared without a name, and sends no placeholder text", async () => {
    await addAlbumItem({ uploaderName: null, listedSecondsAgo: 400 });
    await addAlbumItem({ uploaderName: "Ama Owusu", listedSecondsAgo: 500 });

    const response = await GET();
    const text = await response.text();
    expect(text).not.toContain("[Guest]");
    const answered = JSON.parse(text).slides as Slide[];
    expect(answered.map((slide) => slide.by)).toEqual([null, "Ama Owusu"]);
    for (const slide of answered) {
      for (const value of Object.values(slide)) {
        if (typeof value === "string") expect(value).not.toMatch(/[[\]]/);
      }
    }
  });

  describe("the TV delay", () => {
    it("leaves out a moment listed 60 s ago and shows one listed 200 s ago, with the default three minutes", async () => {
      const recent = await addAlbumItem({ listedSecondsAgo: 60 });
      const older = await addAlbumItem({ listedSecondsAgo: 200 });
      const ids = await idsOf();
      expect(ids).toEqual([older]);
      expect(ids).not.toContain(recent);
    });

    it("shows a moment at once when SLIDESHOW_DELAY_SECONDS is 0", async () => {
      vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "0");
      const justListed = await addAlbumItem({});
      expect(await idsOf()).toEqual([justListed]);
    });

    it("takes the couple's saved delay over SLIDESHOW_DELAY_SECONDS", async () => {
      vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "0");
      await setSetting("slideshow_delay_seconds", 300);
      const recent = await addAlbumItem({ listedSecondsAgo: 200 });
      const older = await addAlbumItem({ listedSecondsAgo: 400 });
      expect(await idsOf()).toEqual([older]);

      vi.stubEnv("SLIDESHOW_DELAY_SECONDS", "600");
      await setSetting("slideshow_delay_seconds", 0);
      const justListed = await addAlbumItem({});
      expect(await idsOf()).toEqual([justListed, recent, older]);
    });
  });

  it("never sends a wish's recording, nor a moment removed by its guest, hidden by the couple, failed, or being processed again", async () => {
    const guest = await createGuest("Kofi Mensah");
    const shown = await addAlbumItem({ listedSecondsAgo: 600 });
    const wishId = randomUUID();
    await addAlbumItem({ id: wishId, purpose: "wish", kind: "video", derived: posterKeys(wishId), listedSecondsAgo: 600 });
    await addAlbumItem({ guestId: guest.id, listedSecondsAgo: 600, hiddenAt: new Date(), hiddenBy: "uploader", removedByUploader: true });
    await addAlbumItem({ listedSecondsAgo: 600, hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    // Listed, still naming a viewing size, but not ready: only their status keeps them off.
    const failed = randomUUID();
    await addAlbumItem({ id: failed, status: "failed", failureReason: "corrupt", derived: photoKeys(failed), listedSecondsAgo: 600 });
    const reprocessing = randomUUID();
    await addAlbumItem({ id: reprocessing, status: "uploaded", derived: photoKeys(reprocessing), listedSecondsAgo: 600 });
    expect(await idsOf()).toEqual([shown]);
  });

  it("drops a moment from the next answer once the couple hide it or its guest removes it (Review Focus 3)", async () => {
    const guest = await createGuest("Kofi Mensah");
    const theirs = await addAlbumItem({ guestId: guest.id, listedSecondsAgo: 600 });
    const hidden = await addAlbumItem({ listedSecondsAgo: 700 });
    const kept = await addAlbumItem({ listedSecondsAgo: 800 });
    expect(await idsOf()).toEqual([theirs, hidden, kept]);

    expect(await hideMedia(hidden, { admin: "couple@example.com" }, { defer: () => {} })).toEqual({ ok: true });
    expect(await idsOf()).toEqual([theirs, kept]);
    expect(await hideMedia(theirs, { guestIds: [guest.id] }, { defer: () => {} })).toEqual({ ok: true });
    expect(await idsOf()).toEqual([kept]);
  });

  it("keeps the list about 15 s, under the album-slides tag every hide drops", async () => {
    await slides();
    expect(cache.tags).toContain("album-slides");
    expect(cache.lives).toContainEqual(expect.objectContaining({ revalidate: 15 }));
  });

  it("keeps 60 slides under 30 KB, even with every name at its 80-character limit", async () => {
    // As in production: the media domain, and Ghanaian letters (two bytes each) in long names.
    vi.stubEnv("MEDIA_BASE_URL", "https://media.nobletxnancy.com");
    const longName = "Ɛfua Ɔforiwaa Ŋkansah-Asantewaa ".repeat(3).slice(0, 80);
    expect([...longName]).toHaveLength(80);
    for (let index = 0; index < 65; index += 1) {
      const id = randomUUID();
      const video = index % 4 === 0;
      await addAlbumItem({
        id,
        kind: video ? "video" : "photo",
        derived: video ? posterKeys(id) : photoKeys(id),
        uploaderName: longName,
        celebration: "thanks",
        width: 1600,
        height: 1200,
        listedSecondsAgo: 23 * 3600 + index,
      });
    }
    const response = await GET();
    const body = await response.text();
    expect(JSON.parse(body).slides).toHaveLength(60);
    expect(Buffer.byteLength(body), `slides.json for 60 slides is ${Buffer.byteLength(body)} bytes`).toBeLessThan(30_000);
  });

  it("answers 503 when the album can't be read, so the TV keeps what it has and asks again", async () => {
    reads.failNext = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("[slideshow]"), expect.anything());
    } finally {
      errors.mockRestore();
    }
    expect(await slides()).toEqual([]);
  });
});
