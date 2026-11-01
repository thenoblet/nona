import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { dbConfig } from "@/lib/env";
import { addAlbumItem, markReadyNow, posterKeys } from "../../../test/album";
import { resetDb } from "../../../test/db";
import {
  albumStats,
  countNewSince,
  decodeCursor,
  encodeCursor,
  everyoneQuery,
  everyoneStatsQuery,
  findAlbumItem,
  findAlbumItems,
  findDownloadable,
  guestQuery,
  guestStatsQuery,
  listAlbum,
  listNewer,
  newSinceQuery,
  pendingQuery,
} from "./album";
import { celebrationsWithItems, countFor } from "./album-item";

// Against the test database (docker compose up -d db).

beforeEach(async () => {
  await resetDb();
});

/** Ready photos listed a second apart, oldest first, ending an hour ago; returns their ids, newest first. */
async function listedPhotos(count: number, overrides: Parameters<typeof addAlbumItem>[0] = {}): Promise<string[]> {
  const ids: string[] = [];
  const firstListed = Date.now() - 3_600_000 - count * 1000;
  for (let index = 0; index < count; index += 1) {
    ids.push(await addAlbumItem({ listedAt: new Date(firstListed + index * 1000), ...overrides }));
  }
  return ids.reverse();
}

/** Every page of the album for these options, cursor by cursor, as the phone scrolls. */
async function everyPage(options: Parameters<typeof listAlbum>[0]): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  do {
    const page = await listAlbum({ ...options, cursor });
    pages.push(page.items.map((item) => item.id));
    cursor = page.nextCursor;
  } while (cursor && pages.length < 50);
  return pages;
}

describe("listAlbum", () => {
  it("pages newest listed first, 30 a page, the next page carrying on where the last stopped", async () => {
    const ids = await listedPhotos(65);
    const pages = await everyPage({ viewerGuestIds: [] });
    expect(pages.map((page) => page.length)).toEqual([30, 30, 5]);
    expect(pages.flat()).toEqual(ids);
  });

  it("never repeats or skips a moment when new ones are listed mid-scroll, nor when one becomes ready late", async () => {
    const ids = await listedPhotos(40);
    // Uploaded before the first page loaded, but its photo only became ready while the guest scrolled.
    const late = await addAlbumItem({ status: "uploaded", uploadedAt: new Date("2026-12-05T17:59:00Z") });

    const first = await listAlbum({ viewerGuestIds: [] });
    const fresh = await addAlbumItem({});
    await markReadyNow(late);
    const second = await listAlbum({ viewerGuestIds: [], cursor: first.nextCursor });

    const seen = [...first.items, ...second.items].map((item) => item.id);
    expect(seen).toEqual(ids);
    expect(new Set(seen).size).toBe(seen.length);
    // Both land above the first page, where the pill brings them in.
    const newer = await listNewer({ viewerGuestIds: [], since: first.newestCursor as string });
    expect(newer?.items.map((item) => item.id)).toEqual([late, fresh]);
    expect(newer?.complete).toBe(true);
    expect((await countNewSince(first.newestCursor as string, {}))?.count).toBe(2);
  });

  it("tells apart moments listed within the same millisecond, by the microsecond and then the id", async () => {
    const shared = "2026-12-05 18:00:00.123";
    const ids = [
      await addAlbumItem({ listedAtText: `${shared}100+00` }),
      await addAlbumItem({ listedAtText: `${shared}200+00` }),
      await addAlbumItem({ id: "00000000-0000-4000-8000-000000000001", listedAtText: `${shared}300+00` }),
      await addAlbumItem({ id: "ffffffff-0000-4000-8000-000000000001", listedAtText: `${shared}300+00` }),
    ].reverse();
    const pages = await everyPage({ viewerGuestIds: [], limit: 1 });
    expect(pages.flat()).toEqual(ids);
  });

  it("filters by celebration, by Photos or Videos, and both at once", async () => {
    const receptionPhoto = await addAlbumItem({ celebration: "reception" });
    const receptionVideo = await addAlbumItem({ celebration: "reception", kind: "video" });
    const ceremonyVideo = await addAlbumItem({ celebration: "ceremony", kind: "video" });
    const morePhoto = await addAlbumItem({ celebration: "more" });

    const ids = async (filter: Parameters<typeof listAlbum>[0]) => (await listAlbum(filter)).items.map((item) => item.id).sort();
    expect(await ids({ viewerGuestIds: [], celebration: "reception" })).toEqual([receptionPhoto, receptionVideo].sort());
    expect(await ids({ viewerGuestIds: [], kind: "video" })).toEqual([receptionVideo, ceremonyVideo].sort());
    expect(await ids({ viewerGuestIds: [], kind: "photo" })).toEqual([receptionPhoto, morePhoto].sort());
    expect(await ids({ viewerGuestIds: [], kind: "video", celebration: "reception" })).toEqual([receptionVideo]);
    expect(await ids({ viewerGuestIds: [], celebration: "more" })).toEqual([morePhoto]);
  });

  it("My uploads shows every guest the browser knows, and combines with Photos or Videos and a celebration", async () => {
    const own = await createGuest("Kofi Mensah");
    const remembered = await createGuest("Ama Owusu");
    const stranger = await createGuest("Yaw Boateng");
    const ownVideo = await addAlbumItem({ guestId: own.id, kind: "video", listedAtText: "2026-12-05 18:00:03+00" });
    const rememberedVideo = await addAlbumItem({ guestId: remembered.id, kind: "video", listedAtText: "2026-12-05 18:00:02+00" });
    const ownPhoto = await addAlbumItem({ guestId: own.id, listedAtText: "2026-12-05 18:00:01+00" });
    await addAlbumItem({ guestId: stranger.id, kind: "video" });
    const ceremonyVideo = await addAlbumItem({ guestId: remembered.id, kind: "video", celebration: "ceremony", listedAtText: "2026-12-05 18:00:00+00" });

    const viewer = [own.id, remembered.id];
    const ids = async (filter: Partial<Parameters<typeof listAlbum>[0]>) =>
      (await listAlbum({ viewerGuestIds: viewer, mine: true, ...filter })).items.map((item) => item.id);
    expect(await ids({})).toEqual([ownVideo, rememberedVideo, ownPhoto, ceremonyVideo]);
    expect(await ids({ kind: "video" })).toEqual([ownVideo, rememberedVideo, ceremonyVideo]);
    expect(await ids({ kind: "video", celebration: "ceremony" })).toEqual([ceremonyVideo]);
    // Merged one page at a time, in order, across both guests.
    expect((await everyPage({ viewerGuestIds: viewer, mine: true, limit: 1 })).flat()).toEqual([ownVideo, rememberedVideo, ownPhoto, ceremonyVideo]);
    // A browser with no guest has nothing of its own.
    expect((await listAlbum({ viewerGuestIds: [], mine: true })).items).toEqual([]);
    expect((await listAlbum({ viewerGuestIds: viewer })).items.filter((item) => item.mine).map((item) => item.id).sort()).toEqual(
      [ownVideo, rememberedVideo, ownPhoto, ceremonyVideo].sort(),
    );
  });

  it("shows no wish, site photo, or anything hidden, removed by its uploader or deleted", async () => {
    const shown = await addAlbumItem({});
    await addAlbumItem({ purpose: "wish", kind: "video" });
    await addAlbumItem({ purpose: "site" });
    await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "noblet" });
    await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true });
    await addAlbumItem({ deletedAt: new Date() });

    expect((await listAlbum({ viewerGuestIds: [] })).items.map((item) => item.id)).toEqual([shown]);
    expect((await albumStats()).everyone).toEqual([{ celebration: "reception", kind: "photo", count: 1 }]);
  });

  it("leads the first page with the browser's own uploads not yet ready, and in My uploads its failed ones, with their reason", async () => {
    const own = await createGuest("Kofi Mensah");
    const stranger = await createGuest("Yaw Boateng");
    const listed = await listedPhotos(31, { guestId: own.id });
    const waiting = await addAlbumItem({ guestId: own.id, status: "uploaded", uploadedAt: new Date(Date.now() - 60_000) });
    const failed = await addAlbumItem({ guestId: own.id, status: "failed", failureReason: "too-large", uploadedAt: new Date(Date.now() - 30_000) });
    await addAlbumItem({ guestId: stranger.id, status: "uploaded" });
    await addAlbumItem({ guestId: stranger.id, status: "failed", failureReason: "corrupt" });
    await addAlbumItem({ guestId: own.id, status: "uploading" });

    const everyone = await listAlbum({ viewerGuestIds: [own.id] });
    expect(everyone.items.map((item) => item.id)).toEqual([waiting, ...listed.slice(0, 30)]);
    expect(everyone.items[0]).toMatchObject({ status: "uploaded", mine: true, thumb: null });

    const mine = await listAlbum({ viewerGuestIds: [own.id], mine: true });
    // Newest upload first (fix round 1, Minor #5): the failed one was added after the waiting one.
    expect(mine.items.slice(0, 2).map((item) => item.id)).toEqual([failed, waiting]);
    expect(mine.items.find((item) => item.id === failed)).toMatchObject({ status: "failed", failure: "too-large" });
    // Paged apart from the cursor: never on a later page, never counted in its 30.
    const later = await listAlbum({ viewerGuestIds: [own.id], mine: true, cursor: mine.nextCursor });
    expect(later.items.map((item) => item.id)).toEqual([listed[30]]);
    // Another browser never sees them.
    expect((await listAlbum({ viewerGuestIds: [stranger.id], mine: true })).items.map((item) => item.status).sort()).toEqual(["failed", "uploaded"]);
    expect((await listAlbum({ viewerGuestIds: [] })).items.every((item) => item.status === "ready")).toBe(true);
  });

  it("gives a video its poster and the versions phones play, never its original; a HEIC is offered as a JPEG", async () => {
    const videoId = randomUUID();
    await addAlbumItem({
      id: videoId,
      kind: "video",
      durationSeconds: 41.6,
      videoCodec: "hevc",
      conversion: "failed",
      conversionFailureReason: "too-long",
      derived: { ...posterKeys(videoId), playable: `derived/${videoId}/fedcba9876543210/playable.mp4` },
    });
    const heicId = randomUUID();
    await addAlbumItem({ id: heicId, contentType: "image/heic", originalKey: `originals/${heicId}.heic`, sizeBytes: 2_100_000 });

    const { items } = await listAlbum({ viewerGuestIds: [] });
    const video = items.find((item) => item.id === videoId);
    expect(video).toMatchObject({
      kind: "video",
      seconds: 42,
      thumb: expect.stringMatching(/poster-thumb\.webp$/),
      view: expect.stringMatching(/poster-view\.webp$/),
      video: {
        converted: null,
        copy: expect.stringMatching(/\/playable\.mp4$/),
        codec: "hevc",
        conversion: "failed",
        conversionFailure: "too-long",
      },
      original: { type: "MOV", bytes: 84_000_000 },
    });
    expect(JSON.stringify(video)).not.toContain("originals/");
    expect(items.find((item) => item.id === heicId)).toMatchObject({ heic: true, original: { type: "HEIC", bytes: 2_100_000 }, video: null });
  });

  it("reads a cursor it didn't make as the first page", async () => {
    const ids = await listedPhotos(3);
    for (const cursor of ["not-a-cursor", Buffer.from("2026-12-05~nope").toString("base64url"), ""]) {
      expect((await listAlbum({ viewerGuestIds: [], cursor })).items.map((item) => item.id)).toEqual(ids);
    }
    expect(decodeCursor(encodeCursor({ listedAt: "2026-12-05T18:00:00.123456Z", id: ids[0] }))).toEqual({
      listedAt: "2026-12-05T18:00:00.123456Z",
      id: ids[0],
    });
  });
});

describe("countNewSince", () => {
  it("counts the moments listed since, with the newest three's thumbnails, and follows the filters", async () => {
    const own = await createGuest("Kofi Mensah");
    await listedPhotos(5);
    const { newestCursor } = await listAlbum({ viewerGuestIds: [] });
    expect(await countNewSince(newestCursor as string, {})).toEqual({ count: 0, newest: [] });

    await addAlbumItem({ kind: "video", celebration: "ceremony" });
    await addAlbumItem({ guestId: own.id });
    await addAlbumItem({});
    const newest = await addAlbumItem({ kind: "video" });
    await addAlbumItem({ status: "uploaded" });
    await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "noblet" });

    const all = await countNewSince(newestCursor as string, {});
    expect(all?.count).toBe(4);
    expect(all?.newest).toHaveLength(3);
    expect(all?.newest[0]).toEqual({ id: newest, thumb: expect.stringMatching(/poster-thumb\.webp$/), color: "#a08070" });
    expect((await countNewSince(newestCursor as string, { kind: "video" }))?.count).toBe(2);
    expect((await countNewSince(newestCursor as string, { kind: "photo" }))?.count).toBe(2);
    expect((await countNewSince(newestCursor as string, { kind: "video", celebration: "ceremony" }))?.count).toBe(1);
    expect((await countNewSince(newestCursor as string, { mine: true }, [own.id]))?.count).toBe(1);
    expect((await countNewSince(newestCursor as string, { mine: true }, []))?.count).toBe(0);
    expect(await countNewSince("not-a-cursor", {})).toBeNull();
  });
});

describe("albumStats", () => {
  it("counts moments by celebration and kind, everyone's and the browser's own, and More moments shows only with some", async () => {
    const own = await createGuest("Kofi Mensah");
    await addAlbumItem({ celebration: "reception" });
    await addAlbumItem({ celebration: "reception", kind: "video" });
    await addAlbumItem({ celebration: "ceremony", guestId: own.id });
    await addAlbumItem({ celebration: "ceremony", guestId: own.id, status: "uploaded" });
    await addAlbumItem({ celebration: "ceremony", guestId: own.id, status: "failed", failureReason: "corrupt" });

    const stats = await albumStats([own.id]);
    expect(countFor(stats, {})).toBe(3);
    expect(countFor(stats, { kind: "video" })).toBe(1);
    expect(countFor(stats, { kind: "photo" })).toBe(2);
    expect(countFor(stats, { celebration: "ceremony" })).toBe(1);
    expect(countFor(stats, { mine: true })).toBe(3);
    expect(celebrationsWithItems(stats).has("more")).toBe(false);

    await addAlbumItem({ celebration: "more" });
    expect(celebrationsWithItems(await albumStats()).has("more")).toBe(true);
  });
});

describe("findAlbumItem and findDownloadable", () => {
  it("finds a listed, visible moment for anyone, and one not ready only for its own browser", async () => {
    const own = await createGuest("Kofi Mensah");
    const ready = await addAlbumItem({});
    const waiting = await addAlbumItem({ guestId: own.id, status: "uploaded" });
    const failed = await addAlbumItem({ guestId: own.id, status: "failed", failureReason: "corrupt" });
    const hidden = await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "noblet" });
    const wish = await addAlbumItem({ purpose: "wish", kind: "video" });

    expect(await findAlbumItem(ready, [])).toMatchObject({ id: ready, status: "ready", mine: false });
    expect(await findAlbumItem(waiting, [])).toBeNull();
    expect(await findAlbumItem(waiting, [own.id])).toMatchObject({ status: "uploaded", mine: true });
    expect(await findAlbumItem(failed, [own.id])).toMatchObject({ status: "failed", failure: "corrupt" });
    for (const id of [hidden, wish, randomUUID(), "not-an-id"]) expect(await findAlbumItem(id, [own.id])).toBeNull();

    expect(await findDownloadable(ready)).toMatchObject({ id: ready, kind: "photo" });
    for (const id of [waiting, failed, hidden, wish, randomUUID(), "not-an-id"]) expect(await findDownloadable(id)).toBeNull();
  });
});

describe("findAlbumItems", () => {
  it("reads the named moments in one query on the primary key, as findAlbumItem would each", async () => {
    const own = await createGuest("Kofi Mensah");
    const ready = await addAlbumItem({});
    const waiting = await addAlbumItem({ guestId: own.id, status: "uploaded" });
    const theirs = await addAlbumItem({ status: "uploaded" });
    const items = await findAlbumItems([ready, waiting, theirs, randomUUID(), "not-an-id"], [own.id]);
    expect(items.map((item) => item.id).sort()).toEqual([ready, waiting].sort());
  });
});

describe("the album's plans", () => {
  const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  afterAll(() => client.end());

  /**
   * A wedding's album, as the planner would see it on the night: 6,000 items from 300 guests, most
   * of them ready photos in the three celebrations, one in eight a video, a few dozen from other
   * days ("More moments"), with wishes, hidden items and uploads in progress beside them, analysed.
   */
  beforeEach(async () => {
    await client`insert into guests (id, link_token)
      select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'token-' || n from generate_series(1, 300) as n`;
    await client`insert into media (purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename,
        size_bytes, content_type, status, listed_at, hidden_at, derived)
      select case when n % 50 = 0 then 'wish' else 'album' end,
        case when n % 8 = 0 then 'video' else 'photo' end,
        ('00000000-0000-4000-8000-' || lpad((n % 300 + 1)::text, 12, '0'))::uuid,
        'Guest', case when n % 150 = 0 then 'more' when n % 3 = 0 then 'ceremony' when n % 3 = 1 then 'reception' else 'thanks' end,
        'originals/plan-' || n || '.jpg', 'IMG.JPG', 3000000, 'image/jpeg',
        case when n % 97 = 0 then 'uploaded' when n % 89 = 0 then 'failed' else 'ready' end,
        case when n % 97 = 0 or n % 89 = 0 then null else now() - make_interval(secs => 6000 - n) end,
        case when n % 211 = 0 then now() else null end, '{}'::jsonb
      from generate_series(1, 6000) as n`;
    // As autovacuum leaves a table that mostly grows (it vacuums after inserts too): analysed, its pages all visible.
    await client`vacuum analyze media`;
  });

  /** The plan Postgres would use for the query once prepared and run with any values (a generic plan, as a pooled prepared statement gets). */
  async function genericPlan(query: { toSQL(): { sql: string } }): Promise<string> {
    const { sql: text } = query.toSQL();
    const rows = await client.unsafe(`explain (generic_plan) ${text}`).simple();
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  const cursor = { listedAt: "2026-12-05T18:00:00.000000Z", id: randomUUID() };
  const guest = "00000000-0000-4000-8000-000000000007";
  const noSortNoSeqScan = (plan: string) => {
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toMatch(/\bSort\b/);
  };

  it("pages everyone's moments along media_album_cursor_idx, the cursor an index condition, with no sort", async () => {
    for (const filter of [{}, { kind: "video" as const }, { celebration: "reception" as const, kind: "photo" as const }]) {
      const plan = await genericPlan(everyoneQuery(filter, { olderThan: cursor }, 31));
      expect(plan).toContain("media_album_cursor_idx");
      expect(plan).toMatch(/Index Cond: .*listed_at/);
      noSortNoSeqScan(plan);
    }
    noSortNoSeqScan(await genericPlan(everyoneQuery({}, {}, 31)));
  });

  it("pages a guest's own moments along media_album_mine_idx with no sort, and finds their items not yet ready by index", async () => {
    for (const query of [guestQuery(guest, { kind: "video" }, { olderThan: cursor }, 31), guestQuery(guest, {}, { newerThan: cursor }, 61)]) {
      const plan = await genericPlan(query);
      expect(plan).toContain("media_album_mine_idx");
      noSortNoSeqScan(plan);
    }
    // A guest's few items not listed yet, newest upload first: read by index, then a sort of those few
    // rows only (fix round 1, Minor #5), never of the album.
    const pending = await genericPlan(pendingQuery(guest, {}, ["uploaded", "failed"]));
    expect(pending).toMatch(/Index/);
    expect(pending).not.toContain("Seq Scan");
    expect(pending).toMatch(/Sort Key: uploaded_at DESC/);
  });

  it("counts the new moments in one query along the album's index (My uploads along the guest's), with no sort", async () => {
    for (const [filter, index] of [
      [{}, "media_album_cursor_idx"],
      [{ kind: "photo" as const }, "media_album_cursor_idx"],
      [{ mine: true }, "media_album_mine_idx"],
    ] as const) {
      const plan = await genericPlan(newSinceQuery(cursor, filter, [guest]));
      expect(plan).toContain(index);
      expect(plan).toMatch(/Index Cond: .*listed_at/);
      noSortNoSeqScan(plan);
    }
  });

  it("counts the album from its own small index alone, and a guest's along theirs, with no sequential scan or sort", async () => {
    const everyone = await genericPlan(everyoneStatsQuery());
    expect(everyone).toContain("Index Only Scan using media_album_stats_idx");
    noSortNoSeqScan(everyone);
    const own = await genericPlan(guestStatsQuery(guest));
    expect(own).toContain("media_album_mine_idx");
    expect(own).not.toContain("Seq Scan");
  });
});
