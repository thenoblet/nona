import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { dbConfig } from "@/lib/env";
import { publicUrl } from "@/lib/storage/keys";
import { addAlbumItem, photoKeys, posterKeys } from "../../../test/album";
import { resetDb } from "../../../test/db";
import { listSlideshowItems, SLIDESHOW_LIMIT, slideshowQuery } from "./slideshow";

// Against the test database (docker compose up -d db).

beforeEach(async () => {
  await resetDb();
});


/** The venue TV's default delay, three minutes. */
const DELAY = 180;

describe("listSlideshowItems", () => {
  it("leaves out a moment listed more recently than the TV delay, and shows one listed before it", async () => {
    const tooRecent = await addAlbumItem({ listedSecondsAgo: 60 });
    const pastTheDelay = await addAlbumItem({ listedSecondsAgo: 200 });

    const ids = (await listSlideshowItems(DELAY)).map((item) => item.id);
    expect(ids).toEqual([pastTheDelay]);
    expect(ids).not.toContain(tooRecent);
  });

  it("shows a moment as soon as it is listed when the delay is 0", async () => {
    const justListed = await addAlbumItem({});
    expect((await listSlideshowItems(0)).map((item) => item.id)).toEqual([justListed]);
  });

  it("holds only the album's ready, visible moments: never a wish, nor a removed, hidden, deleted, failed or unprocessed one", async () => {
    const guest = await createGuest("Kofi Mensah");
    const shown = await addAlbumItem({ listedSecondsAgo: 600 });
    // A video wish's recording: ready, listed and with a poster, but a wish.
    const wishId = randomUUID();
    await addAlbumItem({ id: wishId, purpose: "wish", kind: "video", derived: posterKeys(wishId), listedSecondsAgo: 600 });
    // One of the site's own photos.
    await addAlbumItem({ purpose: "site", listedSecondsAgo: 600 });
    // Removed by its uploader ("Remove my upload" hides it too).
    await addAlbumItem({
      guestId: guest.id,
      listedSecondsAgo: 600,
      hiddenAt: new Date(),
      hiddenBy: "uploader",
      removedByUploader: true,
    });
    await addAlbumItem({ listedSecondsAgo: 600, hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    await addAlbumItem({ listedSecondsAgo: 600, deletedAt: new Date() });
    // Listed once, then not ready: processed again after an Unhide (`uploaded`), or failed on a
    // retry. Listed long ago and still naming a viewing size, so only their status keeps them off.
    const reprocessing = randomUUID();
    await addAlbumItem({ id: reprocessing, status: "uploaded", derived: photoKeys(reprocessing), listedSecondsAgo: 600 });
    const failed = randomUUID();
    await addAlbumItem({ id: failed, status: "failed", failureReason: "corrupt", derived: photoKeys(failed), listedSecondsAgo: 600 });

    expect((await listSlideshowItems(0)).map((item) => item.id)).toEqual([shown]);
  });

  it("puts the newest first, at most 60", async () => {
    const ids: string[] = [];
    for (let index = 0; index < SLIDESHOW_LIMIT + 5; index += 1) {
      ids.push(await addAlbumItem({ listedSecondsAgo: 1000 - index }));
    }
    const items = await listSlideshowItems(DELAY);
    expect(SLIDESHOW_LIMIT).toBe(60);
    expect(items.map((item) => item.id)).toEqual(ids.reverse().slice(0, 60));
  });

  it("shows a photo at its viewing size and a video by its poster's, from the media domain, with their size", async () => {
    const photo = await addAlbumItem({ listedSecondsAgo: 400, width: 1600, height: 1200 });
    const videoId = randomUUID();
    await addAlbumItem({ id: videoId, kind: "video", derived: posterKeys(videoId), width: 720, height: 1280, listedSecondsAgo: 300 });

    const [video, still] = await listSlideshowItems(DELAY);
    expect(video).toMatchObject({ id: videoId, kind: "video", view: publicUrl(posterKeys(videoId)["poster-view"]), width: 720, height: 1280 });
    expect(still).toMatchObject({ id: photo, kind: "photo", view: publicUrl(photoKeys(photo).view), width: 1600, height: 1200 });
  });

  it("names who shared it, or no one when they gave no name, and says when it was listed and in which celebration", async () => {
    const named = await addAlbumItem({ uploaderName: "Efua Asante", celebration: "ceremony", listedAtText: "2026-10-31 14:03:07.123456+00" });
    const unnamed = await addAlbumItem({ uploaderName: null, listedAtText: "2026-10-31 14:02:00+00" });

    const items = await listSlideshowItems(DELAY);
    expect(items).toEqual([
      expect.objectContaining({ id: named, by: "Efua Asante", celebration: "ceremony", listedAt: "2026-10-31T14:03:07.123Z" }),
      expect.objectContaining({ id: unnamed, by: null, celebration: "reception", listedAt: "2026-10-31T14:02:00.000Z" }),
    ]);
  });

  it("skips a ready moment with no viewing size to show rather than send the TV a broken picture", async () => {
    const shown = await addAlbumItem({ listedSecondsAgo: 400 });
    await addAlbumItem({ listedSecondsAgo: 500, derived: {} });
    expect((await listSlideshowItems(DELAY)).map((item) => item.id)).toEqual([shown]);
  });
});

describe("the slideshow's plan", () => {
  const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  afterAll(() => client.end());

  // The album's plans test's wedding (album.test.ts): 6,000 items from 300 guests, with wishes,
  // hidden items and uploads in progress beside them, analysed as autovacuum leaves it.
  beforeEach(async () => {
    await client`insert into guests (id, link_token)
      select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'token-' || n from generate_series(1, 300) as n`;
    await client`insert into media (purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename,
        size_bytes, content_type, status, listed_at, hidden_at, removed_by_uploader, derived)
      select case when n % 50 = 0 then 'wish' else 'album' end,
        case when n % 8 = 0 then 'video' else 'photo' end,
        ('00000000-0000-4000-8000-' || lpad((n % 300 + 1)::text, 12, '0'))::uuid,
        'Guest', case when n % 150 = 0 then 'more' when n % 2 = 0 then 'ceremony' else 'reception' end,
        'originals/plan-' || n || '.jpg', 'IMG.JPG', 3000000, 'image/jpeg',
        case when n % 97 = 0 then 'uploaded' when n % 89 = 0 then 'failed' else 'ready' end,
        case when n % 97 = 0 or n % 89 = 0 then null else now() - make_interval(secs => 6000 - n) end,
        case when n % 211 = 0 or n % 223 = 0 then now() else null end, n % 223 = 0, '{}'::jsonb
      from generate_series(1, 6000) as n`;
    await client`vacuum analyze media`;
  });

  /** The plan for the query prepared and run with any values (a generic plan, as a pooled prepared statement gets). */
  async function genericPlan(query: { toSQL(): { sql: string } }): Promise<string> {
    const { sql: text } = query.toSQL();
    const rows = await client.unsafe(`explain (generic_plan) ${text}`).simple();
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  /** The plan as Postgres runs it with these values, and what it read. */
  async function plan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<string> {
    const { sql: text, params } = query.toSQL();
    const rows = await client.unsafe(`explain (analyze, buffers) ${text}`, params as never[]);
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  it("walks media_album_cursor_idx newest first from the delay's bound, with no sequential scan or sort", async () => {
    for (const shown of [await genericPlan(slideshowQuery(DELAY)), await plan(slideshowQuery(DELAY)), await plan(slideshowQuery(0))]) {
      expect(shown).toContain("Index Scan using media_album_cursor_idx on media");
      // The delay bounds the index itself: rows listed too recently are never read.
      expect(shown).toMatch(/Index Cond: .*listed_at <= \(now\(\) - /);
      expect(shown).not.toContain("Seq Scan");
      expect(shown).not.toMatch(/\bSort\b/);
    }
  });
});
