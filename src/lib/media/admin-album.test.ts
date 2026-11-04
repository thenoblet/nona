import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { dbConfig } from "@/lib/env";
import { addAlbumItem, photoKeys, posterKeys } from "../../../test/album";
import { resetDb } from "../../../test/db";
import {
  adminCountsQuery,
  adminPageQuery,
  findAdminItem,
  guestUploadsQuery,
  listAdminAlbum,
  readAdminCounts,
} from "./admin-album";
import { countsFor } from "./admin-item";
import { adminWishesQuery, countAdminWishes, findAdminWish, listAdminWishes } from "./admin-wishes";
import { deletableFrom } from "./moderation";
import { decodeTimeCursor, encodeTimeCursor } from "./time-cursor";
import { getDb } from "@/lib/db/client";
import { wishes } from "@/lib/db/schema";
import { publicUrl } from "@/lib/storage/keys";

// Against the test database (docker compose up -d db). Each describe but the plans' starts every
// test from an empty database; the plans' fill it once.

/** Items uploaded a second apart, oldest first, ending an hour ago; returns their ids, newest upload first. */
async function uploadedItems(count: number, overrides: Parameters<typeof addAlbumItem>[0] = {}): Promise<string[]> {
  const ids: string[] = [];
  const firstUploaded = Date.now() - 3_600_000 - count * 1000;
  for (let index = 0; index < count; index += 1) {
    ids.push(await addAlbumItem({ uploadedAt: new Date(firstUploaded + index * 1000), ...overrides }));
  }
  return ids.reverse();
}

describe("listAdminAlbum", () => {
  beforeEach(resetDb);

  it("lists every album item that finished uploading, newest upload first: hidden and removed ones too, never a tombstone, an upload under way or a wish", async () => {
    const [newest, middle, oldest] = await uploadedItems(3);
    const hidden = await addAlbumItem({ uploadedAt: new Date(Date.now() - 60_000), hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    const removed = await addAlbumItem({ uploadedAt: new Date(Date.now() - 50_000), hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true });
    await addAlbumItem({ uploadedAt: new Date(), deletedAt: new Date() });
    await addAlbumItem({ status: "uploading", uploadedAt: null });
    await addAlbumItem({ purpose: "wish", kind: "audio", uploadedAt: new Date() });

    const page = await listAdminAlbum({ filter: {} });
    expect(page.items.map((item) => item.id)).toEqual([removed, hidden, newest, middle, oldest]);
    expect(page.nextCursor).toBeNull();
  });

  it("gives each item one state, the first that applies, as its badge and its chip", async () => {
    const ids = {
      removedAndFailed: await addAlbumItem({ status: "failed", hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      hiddenAndFailed: await addAlbumItem({ status: "failed", hiddenAt: new Date(), hiddenBy: "couple@example.com" }),
      failed: await addAlbumItem({ status: "failed", failureReason: "corrupt" }),
      conversionFailed: await addAlbumItem({ kind: "video", conversion: "failed", conversionFailureReason: "too-slow" }),
      processing: await addAlbumItem({ status: "uploaded" }),
      converting: await addAlbumItem({ kind: "video", conversion: "converting" }),
      queued: await addAlbumItem({ kind: "video", conversion: "queued" }),
      visibleVideo: await addAlbumItem({ kind: "video", conversion: "done" }),
      visiblePhoto: await addAlbumItem({}),
    };
    const { items } = await listAdminAlbum({ filter: {} });
    const stateOf = (id: string) => items.find((item) => item.id === id)?.state;
    expect(stateOf(ids.removedAndFailed)).toBe("removed");
    expect(stateOf(ids.hiddenAndFailed)).toBe("hidden");
    expect(stateOf(ids.failed)).toBe("failed");
    expect(stateOf(ids.conversionFailed)).toBe("failed");
    expect(stateOf(ids.processing)).toBe("processing");
    expect(stateOf(ids.converting)).toBe("converting");
    expect(stateOf(ids.queued)).toBe("queued");
    expect(stateOf(ids.visibleVideo)).toBeNull();
    expect(stateOf(ids.visiblePhoto)).toBeNull();

    expect(items.find((item) => item.id === ids.failed)?.failure).toEqual({ during: "processing", reason: "corrupt" });
    expect(items.find((item) => item.id === ids.conversionFailed)?.failure).toEqual({ during: "conversion", reason: "too-slow" });
    expect(items.find((item) => item.id === ids.visiblePhoto)?.failure).toBeNull();
  });

  it("shows a hidden or removed item's ThumbHash but never its public files' URLs, which a hide deletes (Ruling BV)", async () => {
    const hiddenId = randomUUID();
    await addAlbumItem({ id: hiddenId, hiddenAt: new Date(), hiddenBy: "couple@example.com", derived: photoKeys(hiddenId) });
    const removedId = randomUUID();
    await addAlbumItem({ id: removedId, kind: "video", hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true, derived: posterKeys(removedId) });
    const visible = await addAlbumItem({});

    const { items } = await listAdminAlbum({ filter: {} });
    for (const id of [hiddenId, removedId]) {
      const item = items.find((candidate) => candidate.id === id)!;
      expect(item.thumb).toBeNull();
      expect(item.view).toBeNull();
      expect(item.thumbhash).toBe("1QcSHQRnh493V4dIh4eXh1h4kJUI");
    }
    const shown = items.find((item) => item.id === visible)!;
    expect(shown.thumb).toMatch(/\/derived\/.+\/thumb\.webp$/);
    expect(shown.view).toMatch(/\/derived\/.+\/view\.webp$/);
  });

  it("says who hid an item and when, how many items its guest shared, and when it may be deleted", async () => {
    const guest = await createGuest("Ama Owusu");
    const uploadedAt = new Date("2026-12-05T19:30:00Z");
    const hidden = await addAlbumItem({
      guestId: guest.id,
      uploaderName: "Ama Owusu",
      uploadedAt,
      hiddenAt: new Date("2026-12-05T19:41:00Z"),
      hiddenBy: "couple@example.com",
      contentType: "image/heic",
      originalKey: `originals/${randomUUID()}.heic`,
    });
    await addAlbumItem({ guestId: guest.id });
    await addAlbumItem({ guestId: guest.id, deletedAt: new Date() });
    await addAlbumItem({ guestId: (await createGuest("Kofi")).id });

    const item = (await listAdminAlbum({ filter: {} })).items.find((candidate) => candidate.id === hidden)!;
    expect(item).toMatchObject({
      by: "Ama Owusu",
      uploads: 2,
      uploadedAt: uploadedAt.toISOString(),
      hiddenAt: "2026-12-05T19:41:00.000Z",
      hiddenBy: "couple@example.com",
      deletableFrom: deletableFrom(uploadedAt).toISOString(),
      original: { type: "HEIC", bytes: 4_200_000, heic: true },
    });
  });

  it("filters by state chip, celebration, kind and who shared it, case-insensitively, together", async () => {
    const amaPhoto = await addAlbumItem({ uploaderName: "Ama Owusu", celebration: "ceremony" });
    const amaVideo = await addAlbumItem({ uploaderName: "Ama Owusu", kind: "video", celebration: "more", highlight: true });
    const kofiFailed = await addAlbumItem({ uploaderName: "Kofi Mensah", status: "failed", celebration: "ceremony" });
    const percent = await addAlbumItem({ uploaderName: "100% Kojo_Antwi" });
    const hidden = await addAlbumItem({ uploaderName: "Kofi Mensah", hiddenAt: new Date(), hiddenBy: "couple@example.com" });

    const ids = async (filter: Parameters<typeof listAdminAlbum>[0]["filter"]) =>
      (await listAdminAlbum({ filter })).items.map((item) => item.id).sort();
    expect(await ids({ chip: "failed" })).toEqual([kofiFailed]);
    expect(await ids({ chip: "hidden" })).toEqual([hidden]);
    expect(await ids({ chip: "highlights" })).toEqual([amaVideo]);
    expect(await ids({ celebration: "ceremony" })).toEqual([amaPhoto, kofiFailed].sort());
    expect(await ids({ celebration: "more" })).toEqual([amaVideo]);
    expect(await ids({ kind: "video" })).toEqual([amaVideo]);
    expect(await ids({ search: "AMA" })).toEqual([amaPhoto, amaVideo].sort());
    expect(await ids({ search: "owusu", kind: "photo" })).toEqual([amaPhoto]);
    expect(await ids({ search: "mensah", chip: "failed", celebration: "ceremony" })).toEqual([kofiFailed]);
    // A % or _ is a letter of the name, not a wildcard.
    expect(await ids({ search: "100%" })).toEqual([percent]);
    expect(await ids({ search: "o_A" })).toEqual([percent]);
    expect(await ids({ search: "%" })).toEqual([percent]);
    expect(await ids({ search: "nobody" })).toEqual([]);
  });

  it("pages by a cursor of the upload time and id, so an item uploaded meanwhile never shifts the pages below", async () => {
    const ids = await uploadedItems(31);
    const first = await listAdminAlbum({ filter: {} });
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 30));
    expect(first.nextCursor).not.toBeNull();

    await addAlbumItem({ uploadedAt: new Date() });
    const second = await listAdminAlbum({ filter: {}, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(30));
    expect(second.nextCursor).toBeNull();
  });

  it("pages items that share one upload time across page breaks by their ids, with no item twice and none left out", async () => {
    const tied = new Date("2026-12-05T18:00:00.123Z");
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) ids.push(await addAlbumItem({ uploadedAt: new Date(tied.getTime() + (index + 1) * 1000) }));
    for (let index = 0; index < 10; index += 1) ids.push(await addAlbumItem({ uploadedAt: tied }));
    for (let index = 0; index < 2; index += 1) ids.push(await addAlbumItem({ uploadedAt: new Date(tied.getTime() - (index + 1) * 1000) }));
    const uploaded = new Map((await listAdminAlbum({ filter: {}, limit: 50 })).items.map((item) => [item.id, item.uploadedAt]));
    // Newest upload first, the id (descending) breaking ties, as media_admin_idx reads them.
    const expected = [...ids].sort((first, second) => {
      const byTime = uploaded.get(second)!.localeCompare(uploaded.get(first)!);
      return byTime !== 0 ? byTime : second.localeCompare(first);
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listAdminAlbum({ filter: {}, cursor, limit: 4 });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(15);
  });

  it("reads a cursor it didn't make as the first page", async () => {
    const ids = await uploadedItems(2);
    for (const cursor of ["nonsense", encodeTimeCursor({ at: "yesterday", id: randomUUID() }), "x".repeat(300)]) {
      expect((await listAdminAlbum({ filter: {}, cursor })).items.map((item) => item.id)).toEqual(ids);
    }
    const cursor = { at: "2026-12-05T18:00:00.123456Z", id: randomUUID() };
    expect(decodeTimeCursor(encodeTimeCursor(cursor))).toEqual(cursor);
  });
});

describe("the admin's counts", () => {
  beforeEach(resetDb);

  it("counts the album by celebration and kind in one grouped query, and sums them for the celebration and kind shown", async () => {
    await addAlbumItem({ celebration: "ceremony" });
    await addAlbumItem({ celebration: "ceremony", status: "failed" });
    await addAlbumItem({ celebration: "reception", kind: "video", conversion: "queued", highlight: true });
    await addAlbumItem({ celebration: "reception", kind: "video", conversion: "converting" });
    await addAlbumItem({ celebration: "more", status: "uploaded" });
    await addAlbumItem({ celebration: "more", hiddenAt: new Date(), hiddenBy: "couple@example.com", highlight: true });
    await addAlbumItem({ celebration: "more", hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true });
    await addAlbumItem({ celebration: "more", deletedAt: new Date() });

    const rows = await readAdminCounts();
    expect(countsFor(rows, {})).toEqual({
      total: 7,
      chips: { failed: 1, processing: 1, converting: 1, queued: 1, hidden: 1, removed: 1, highlights: 2 },
    });
    expect(countsFor(rows, { celebration: "more" })).toEqual({
      total: 3,
      chips: { failed: 0, processing: 1, converting: 0, queued: 0, hidden: 1, removed: 1, highlights: 1 },
    });
    expect(countsFor(rows, { kind: "video" })).toMatchObject({ total: 2, chips: { queued: 1, converting: 1, highlights: 1 } });
  });
});

describe("findAdminItem", () => {
  beforeEach(resetDb);

  it("finds one item of the admin's album by its id, and nothing else", async () => {
    const item = await addAlbumItem({ hiddenAt: new Date(), hiddenBy: "couple@example.com" });
    const deleted = await addAlbumItem({ deletedAt: new Date() });
    const wish = await addAlbumItem({ purpose: "wish", kind: "audio" });
    expect(await findAdminItem(item)).toMatchObject({ id: item, state: "hidden" });
    for (const id of [deleted, wish, randomUUID(), "not-an-id"]) expect(await findAdminItem(id)).toBeNull();
  });
});

describe("the admin's wishes", () => {
  beforeEach(resetDb);

  it("lists every wish but the deleted, hidden ones too, newest first, with a recording's lock date", async () => {
    const older = await getDb()
      .insert(wishes)
      .values({ signedAs: "Auntie Adwoa", kind: "text", message: "A big kitchen.", createdAt: new Date("2026-12-04T18:20:00Z") })
      .returning();
    const recordingUploaded = new Date("2026-12-05T20:47:00Z");
    const recording = await addAlbumItem({ purpose: "wish", kind: "audio", uploadedAt: recordingUploaded, durationSeconds: 42 });
    const voice = await getDb()
      .insert(wishes)
      .values({ signedAs: "Kwame", kind: "voice", mediaId: recording, createdAt: new Date("2026-12-05T20:48:00Z") })
      .returning();
    const hidden = await getDb()
      .insert(wishes)
      .values({ signedAs: "Kojo", kind: "text", message: "Free drinks!", createdAt: new Date("2026-12-05T19:58:00Z"), hiddenAt: new Date(), hiddenBy: "couple@example.com" })
      .returning();
    await getDb().insert(wishes).values({ signedAs: "deleted", kind: "text", message: "", deletedAt: new Date() });

    const page = await listAdminWishes({});
    expect(page.wishes.map((wish) => wish.id)).toEqual([voice[0].id, hidden[0].id, older[0].id]);
    expect(page.wishes[0]).toMatchObject({
      kind: "voice",
      signedAs: "Kwame",
      recording: { mediaId: recording, kind: "audio", status: "ready", seconds: 42 },
      deletableFrom: deletableFrom(recordingUploaded).toISOString(),
    });
    expect(page.wishes[1]).toMatchObject({ message: "Free drinks!", hiddenBy: "couple@example.com", recording: null, deletableFrom: null });
    expect(await countAdminWishes()).toBe(3);
    expect(await findAdminWish(hidden[0].id)).toMatchObject({ id: hidden[0].id, hiddenAt: expect.any(String) });
    expect(await findAdminWish("not-an-id")).toBeNull();
  });

  it("plays a ready recording from the file the wall plays (and a video's small poster); none while it is made, failed or hidden", async () => {
    const insertWish = async (kind: "voice" | "video", mediaId: string) =>
      (await getDb().insert(wishes).values({ signedAs: "Kwame", kind, mediaId }).returning())[0].id;
    const voiceId = await addAlbumItem({ purpose: "wish", kind: "audio", derived: { audio: "derived/v/0123456789abcdef/audio.m4a" } });
    const videoId = await addAlbumItem({
      purpose: "wish",
      kind: "video",
      derived: {
        video: "derived/w/0123456789abcdef/video.mp4",
        "poster-thumb": "derived/w/0123456789abcdef/poster-thumb.webp",
        "poster-view": "derived/w/0123456789abcdef/poster-view.webp",
      },
    });
    const processingId = await addAlbumItem({ purpose: "wish", kind: "audio", status: "uploaded" });
    const hiddenId = await addAlbumItem({
      purpose: "wish",
      kind: "audio",
      derived: { audio: "derived/h/0123456789abcdef/audio.m4a" },
      hiddenAt: new Date(),
      hiddenBy: "couple@example.com",
    });
    const voice = await insertWish("voice", voiceId);
    const video = await insertWish("video", videoId);
    const processing = await insertWish("voice", processingId);
    const hidden = await insertWish("voice", hiddenId);

    expect((await findAdminWish(voice))?.recording).toMatchObject({ url: publicUrl("derived/v/0123456789abcdef/audio.m4a"), poster: null });
    expect((await findAdminWish(video))?.recording).toMatchObject({
      url: publicUrl("derived/w/0123456789abcdef/video.mp4"),
      // The 480 px poster, as the wall's: a page of 50 wishes never fetches 50 full-size ones.
      poster: publicUrl("derived/w/0123456789abcdef/poster-thumb.webp"),
    });
    for (const id of [processing, hidden]) expect((await findAdminWish(id))?.recording).toMatchObject({ url: null, poster: null });
  });

  it("pages the wishes by a cursor", async () => {
    for (let index = 0; index < 52; index += 1) {
      await getDb().insert(wishes).values({ signedAs: `Guest ${index}`, kind: "text", message: "Congratulations!", createdAt: new Date(Date.UTC(2026, 11, 5, 18, 0, index)) });
    }
    const first = await listAdminWishes({});
    expect(first.wishes).toHaveLength(50);
    expect(first.wishes[0].signedAs).toBe("Guest 51");
    const second = await listAdminWishes({ cursor: first.nextCursor });
    expect(second.wishes.map((wish) => wish.signedAs)).toEqual(["Guest 1", "Guest 0"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("the admin's plans (Ruling BW)", () => {
  const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  afterAll(() => client.end());

  /**
   * The night's album as the planner would see it: 6,000 items from 300 guests with their names,
   * most of them ready photos in the three celebrations, one in eight a video (some converting or
   * queued for conversion), a few dozen from other days, failed, processing, hidden, removed and
   * highlighted ones, uploads under way and wishes' recordings beside them, with the derived keys,
   * ThumbHash and fingerprint a real row carries, analysed and vacuumed as autovacuum leaves a table
   * that mostly grows.
   */
  beforeAll(async () => {
    await resetDb();
    await client`insert into guests (id, link_token, display_name)
      select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'token-' || n,
        (array['Ama','Kofi','Abena','Kwame','Efua','Yaw','Akosua','Kojo','Adwoa','Kwesi','Esi','Nana','Selorm','Dzifa','Mawuli'])[1 + n % 15] || ' ' ||
        (array['Owusu','Mensah','Asante','Boateng','Darko','Antwi','Ansah','Sarpong','Ofori','Agbeko','Kpodo','Appiah','Addo','Quaye','Tetteh','Amoah','Badu','Frimpong','Gyamfi','Osei'])[1 + (n / 15) % 20]
      from generate_series(1, 300) as n`;
    await client`insert into media (purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename,
        size_bytes, content_type, status, uploaded_at, listed_at, captured_at, hidden_at, hidden_by, removed_by_uploader, derived,
        width, height, thumbhash, average_color, conversion, highlight, video_codec, browser_playable, file_fingerprint)
      select case when n % 50 = 0 then 'wish' else 'album' end,
        case when n % 8 = 0 then 'video' else 'photo' end,
        guest.id, guest.display_name,
        case when n % 150 = 0 then 'more' when n % 3 = 0 then 'ceremony' when n % 3 = 1 then 'reception' else 'thanks' end,
        'originals/' || gen_random_uuid() || case when n % 8 = 0 then '.mov' else '.jpg' end, 'IMG_' || n || '.JPG', 3000000, 'image/jpeg',
        case when n % 97 = 0 then 'uploaded' when n % 89 = 0 then 'failed' when n % 400 = 0 then 'uploading' else 'ready' end,
        case when n % 400 = 0 then null else now() - make_interval(secs => 6000 - n) end,
        case when n % 97 = 0 or n % 89 = 0 or n % 400 = 0 then null else now() - make_interval(secs => 6000 - n) end,
        now() - make_interval(secs => 6100 - n),
        case when n % 211 = 0 or n % 307 = 0 then now() else null end,
        case when n % 307 = 0 then 'guest' when n % 211 = 0 then 'couple@example.com' else null end,
        n % 307 = 0,
        jsonb_build_object('thumb', 'derived/' || gen_random_uuid() || '/0123456789abcdef/thumb.webp', 'view', 'derived/' || gen_random_uuid() || '/0123456789abcdef/view.webp')
          || case when n % 8 = 0 then jsonb_build_object('playable', 'derived/' || gen_random_uuid() || '/0123456789abcdef/playable.mp4') else '{}'::jsonb end,
        1200, 1600, '1QcSHQRnh493V4dIh4eXh1h4kJUI', '#a08070',
        case when n % 8 <> 0 then 'none' when n % 64 = 0 then 'queued' when n % 600 = 0 then 'converting' when n % 1000 = 0 then 'failed' else 'done' end,
        n % 53 = 0, case when n % 8 = 0 then 'hevc' else null end, case when n % 8 = 0 then false else null end,
        encode(sha256(n::text::bytea), 'hex')
      from generate_series(1, 6000) as n
      join guests as guest on guest.id = ('00000000-0000-4000-8000-' || lpad((n % 300 + 1)::text, 12, '0'))::uuid`;
    await client`insert into wishes (signed_as, kind, message, created_at, hidden_at)
      select 'Guest ' || n, 'text', 'Congratulations and a long, happy life together ' || n, now() - make_interval(secs => 3000 - n),
        case when n % 40 = 0 then now() else null end
      from generate_series(1, 600) as n`;
    await client`vacuum analyze media`;
    await client`vacuum analyze wishes`;
  }, 60_000);

  // The other tests in this file start from an empty database again.
  afterAll(async () => {
    await resetDb();
  });

  /** The plan Postgres would use for the query once prepared and run with any values (a generic plan, as a pooled prepared statement gets). */
  async function genericPlan(query: { toSQL(): { sql: string } }): Promise<string> {
    const { sql: text } = query.toSQL();
    const rows = await client.unsafe(`explain (generic_plan) ${text}`).simple();
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  const cursor = { at: "2026-12-05T18:00:00.000000Z", id: randomUUID() };
  const noSortNoSeqScan = (plan: string) => {
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toMatch(/\bSort\b/);
  };

  it("pages the whole album along media_admin_idx, kind or not, with no sort", async () => {
    for (const [filter, window] of [
      [{}, null],
      [{}, cursor],
      [{ kind: "video" as const }, cursor],
    ] as const) {
      const plan = await genericPlan(adminPageQuery(filter, window, 31));
      expect(plan).toContain("Index Only Scan using media_admin_idx");
      noSortNoSeqScan(plan);
    }
  });

  it("pages a celebration along media_admin_celebration_idx, More moments too, with no sort", async () => {
    for (const filter of [{ celebration: "more" as const }, { celebration: "reception" as const, kind: "photo" as const }]) {
      const plan = await genericPlan(adminPageQuery(filter, cursor, 31));
      expect(plan).toContain("media_admin_celebration_idx");
      expect(plan).toMatch(/Index Cond: .*celebration/);
      noSortNoSeqScan(plan);
    }
  });

  it("pages each state chip along media_admin_state_idx, and Highlights along its own, with no sort", async () => {
    for (const chip of ["failed", "processing", "converting", "queued", "hidden", "removed"] as const) {
      const plan = await genericPlan(adminPageQuery({ chip }, cursor, 31));
      expect(plan).toContain("Index Only Scan using media_admin_state_idx");
      expect(plan).toContain(`'${chip}'::text`);
      noSortNoSeqScan(plan);
    }
    const highlights = await genericPlan(adminPageQuery({ chip: "highlights", kind: "video" }, null, 31));
    expect(highlights).toContain("media_admin_highlight_idx");
    noSortNoSeqScan(highlights);
  });

  it("searches who shared it from an index alone, in order, with no sort, whatever else is chosen", async () => {
    for (const filter of [
      { search: "ama" },
      { search: "zz" },
      { search: "mensah", kind: "video" as const },
      { search: "ama", celebration: "thanks" as const },
      { search: "kofi", chip: "hidden" as const },
      { search: "kofi", chip: "highlights" as const },
    ]) {
      const plan = await genericPlan(adminPageQuery(filter, cursor, 31));
      expect(plan).toMatch(/Index Only Scan using media_admin_(state_|highlight_)?idx/);
      expect(plan).toMatch(/Filter: .*uploader_name ~~\*/);
      noSortNoSeqScan(plan);
    }
  });

  /**
   * The plan Postgres makes with the values in it, as a prepared statement's first five runs get
   * (custom plans): the pattern a search sends, the chip and the cursor written into the query.
   */
  async function literalPlan(query: { toSQL(): { sql: string; params: unknown[] } }): Promise<string> {
    const { sql: text, params } = query.toSQL();
    const literal = text.replace(/\$(\d+)/g, (_, position: string) => {
      const value = params[Number(position) - 1];
      return typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
    });
    const rows = await client.unsafe(`explain ${literal}`).simple();
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  it("keeps to the indexes with the values written in too: a search that matches no one, and a chip", async () => {
    for (const [filter, window] of [
      [{ search: "zz" }, null],
      [{ search: "zz" }, cursor],
      [{ chip: "failed" as const }, null],
    ] as const) {
      const plan = await literalPlan(adminPageQuery(filter, window, 31));
      expect(plan).toMatch(/Index Only Scan using media_admin_(state_)?idx/);
      if (filter.search) expect(plan).toContain("'%zz%'");
      noSortNoSeqScan(plan);
    }
  });

  it("joins a page's rows by primary key, keeping the index's order", async () => {
    const plan = await genericPlan(adminPageQuery({}, cursor, 31));
    expect(plan).toContain("Nested Loop");
    expect(plan).toContain("Index Scan using media_pkey");
  });

  it("counts every chip in one grouped query that reads media_admin_counts_idx alone, with no sort", async () => {
    const plan = await genericPlan(adminCountsQuery());
    expect(plan).toContain("Index Only Scan using media_admin_counts_idx");
    expect(plan).toMatch(/Aggregate/);
    noSortNoSeqScan(plan);
  });

  it("counts a page's guests' uploads in one query on media_guest_id_idx, with no sort", async () => {
    const guests = Array.from({ length: 25 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
    const plan = await genericPlan(guestUploadsQuery(guests));
    expect(plan).toContain("media_guest_id_idx");
    noSortNoSeqScan(plan);
  });

  it("pages the wishes along wishes_admin_idx, each recording by primary key, with no sort", async () => {
    for (const window of [null, { at: "2026-12-05T18:00:00.000000Z", id: randomUUID() }]) {
      const plan = await genericPlan(adminWishesQuery(window, 51));
      expect(plan).toContain("wishes_admin_idx");
      expect(plan).not.toContain("Seq Scan");
      expect(plan).not.toMatch(/\bSort\b/);
    }
  });
});
