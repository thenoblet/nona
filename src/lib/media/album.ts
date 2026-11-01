import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { publicUrl } from "@/lib/storage/keys";
import type {
  AlbumCelebration,
  AlbumCount,
  AlbumFilter,
  AlbumItem,
  AlbumKind,
  AlbumPage,
  AlbumStats,
} from "./album-item";

/*
 * The album's queries (Task 15). Everyone sees album items that are `ready` and visible (not
 * hidden, deleted or removed by their uploader), newest listed first, the id breaking ties: the
 * order of media_album_cursor_idx, read without a sort. A page is cut by a cursor (the last item's
 * listed_at and id), so a moment listed while a guest scrolls lands above their first page and
 * never shifts the pages below it; one that becomes ready late is listed then, and so lands on top
 * too. Wishes (purpose `wish`) never show here.
 *
 * Each condition the indexes' own conditions name (purpose, status, hidden_at, deleted_at) is
 * written as a literal, never a bound value, so Postgres can prove the partial index applies under a
 * generic plan, as a pooled prepared statement gets. "My uploads" reads one guest at a time along
 * media_album_mine_idx and merges them, so it never sorts either. A browser's own items that aren't
 * listed (uploaded, waiting for the worker; failed, with their reason) come apart from the cursor,
 * on the first page only.
 */

/** A page's size unless the caller asks for another. */
export const ALBUM_PAGE_SIZE = 30;
/** The most moments newer than a guest's newest the pill brings in at once; past it the first page is read again. */
export const NEWER_LIMIT = 60;
/** The most of a guest's own items not yet listed that the first page shows. */
const PENDING_LIMIT = 50;

/** Where a page ends: the last item's listed_at, to the microsecond, and its id. */
export type AlbumCursor = { listedAt: string; id: string };

// listed_at to the microsecond, in UTC: a JavaScript Date keeps only milliseconds, which would make
// a cursor fall between two items listed in the same millisecond.
const LISTED_AT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** Before every moment: where an empty album's new-moments check counts from. */
const ALBUM_START: AlbumCursor = { listedAt: "1970-01-01T00:00:00.000000Z", id: "00000000-0000-0000-0000-000000000000" };

/** The cursor as the page carries it: opaque, URL-safe. */
export function encodeCursor(cursor: AlbumCursor): string {
  return Buffer.from(`${cursor.listedAt}~${cursor.id}`).toString("base64url");
}

/** The cursor a page sent, or null when it isn't one this server made. */
export function decodeCursor(value: string | null | undefined): AlbumCursor | null {
  if (!value || value.length > 200) return null;
  const [listedAt, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("~");
  if (rest.length > 0 || !listedAt || !id || !LISTED_AT_TEXT.test(listedAt) || !isUuid(id)) return null;
  return { listedAt, id: id.toLowerCase() };
}

/** What the album reads of each item. */
const itemColumns = {
  id: media.id,
  kind: media.kind,
  status: media.status,
  guestId: media.guestId,
  uploaderName: media.uploaderName,
  celebration: media.celebration,
  listedAt: sql<string | null>`to_char(${media.listedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  capturedAt: media.capturedAt,
  uploadedAt: media.uploadedAt,
  width: media.width,
  height: media.height,
  durationSeconds: media.durationSeconds,
  thumbhash: media.thumbhash,
  averageColor: media.averageColor,
  derived: media.derived,
  videoCodec: media.videoCodec,
  conversion: media.conversion,
  conversionFailureReason: media.conversionFailureReason,
  contentType: media.contentType,
  sizeBytes: media.sizeBytes,
  originalKey: media.originalKey,
  failureReason: media.failureReason,
};

type ItemRow = {
  id: string;
  kind: "photo" | "video" | "audio";
  status: "uploading" | "uploaded" | "ready" | "failed";
  guestId: string | null;
  uploaderName: string | null;
  celebration: AlbumCelebration;
  listedAt: string | null;
  capturedAt: Date | null;
  uploadedAt: Date | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbhash: string | null;
  averageColor: string | null;
  derived: Partial<Record<string, string>>;
  videoCodec: string | null;
  conversion: "none" | "queued" | "converting" | "done" | "failed";
  conversionFailureReason: string | null;
  contentType: string;
  sizeBytes: number;
  originalKey: string;
  failureReason: string | null;
};

const HEIC_TYPES = new Set(["image/heic", "image/heif"]);

/** The original's type in a word, from its key's extension: "JPEG", "HEIC", "MOV". */
function originalType(originalKey: string): string {
  const extension = originalKey.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "jpg" || extension === "jpeg") return "JPEG";
  return extension.toUpperCase();
}

function urlOf(key: string | undefined): string | null {
  return key ? publicUrl(key) : null;
}

/** An item as the page has it, for a browser that knows these guests. */
export function toAlbumItem(row: ItemRow, viewerGuestIds: readonly string[]): AlbumItem {
  const video = row.kind === "video";
  // To the millisecond for the page (the microseconds matter only to a cursor, made apart).
  const listedAt = row.listedAt ? `${row.listedAt.slice(0, 23)}Z` : null;
  return {
    id: row.id,
    kind: video ? "video" : "photo",
    status: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "uploaded",
    mine: row.guestId !== null && viewerGuestIds.includes(row.guestId),
    by: row.uploaderName,
    celebration: row.celebration,
    takenAt: row.capturedAt?.toISOString() ?? listedAt ?? row.uploadedAt?.toISOString() ?? null,
    listedAt,
    width: row.width,
    height: row.height,
    thumbhash: row.thumbhash,
    color: row.averageColor,
    thumb: urlOf(video ? row.derived["poster-thumb"] : row.derived.thumb),
    view: urlOf(video ? row.derived["poster-view"] : row.derived.view),
    seconds: video && row.durationSeconds !== null ? Math.round(row.durationSeconds) : null,
    video: video
      ? {
          converted: urlOf(row.derived.video),
          copy: urlOf(row.derived.playable),
          codec: row.videoCodec,
          conversion: row.conversion,
          conversionFailure: row.conversionFailureReason,
        }
      : null,
    heic: !video && HEIC_TYPES.has(row.contentType),
    original: { type: originalType(row.originalKey), bytes: row.sizeBytes },
    failure: row.status === "failed" ? (row.failureReason ?? "processing-failed") : null,
  };
}

/** Album items anyone may see: in the album, not hidden, deleted or removed by their uploader. */
function visibleAlbumItems(): SQL {
  return sql`${media.purpose} = 'album' and ${media.hiddenAt} is null and ${media.deletedAt} is null and not ${media.removedByUploader}`;
}

function filterConditions(filter: AlbumFilter): (SQL | undefined)[] {
  return [
    filter.kind ? eq(media.kind, filter.kind) : undefined,
    filter.celebration ? eq(media.celebration, filter.celebration) : undefined,
  ];
}

/** Where a page starts: after the cursor (older), or for the pill, before it (newer). */
type Window = { olderThan?: AlbumCursor; newerThan?: AlbumCursor };

function windowConditions(window: Window): (SQL | undefined)[] {
  return [
    window.olderThan
      ? sql`(${media.listedAt}, ${media.id}) < (${window.olderThan.listedAt}::timestamptz, ${window.olderThan.id}::uuid)`
      : undefined,
    window.newerThan
      ? sql`(${media.listedAt}, ${media.id}) > (${window.newerThan.listedAt}::timestamptz, ${window.newerThan.id}::uuid)`
      : undefined,
  ];
}

/**
 * Everyone's listed items, newest first, along media_album_cursor_idx. Exported so a test can check
 * its plan.
 */
export function everyoneQuery(filter: AlbumFilter, window: Window, limit: number) {
  return getDb()
    .select(itemColumns)
    .from(media)
    .where(and(visibleAlbumItems(), sql`${media.status} = 'ready'`, ...filterConditions(filter), ...windowConditions(window)))
    .orderBy(desc(media.listedAt), desc(media.id))
    .limit(limit);
}

/**
 * One guest's own listed items, newest first, along media_album_mine_idx. Exported so a test can
 * check its plan.
 */
export function guestQuery(guestId: string, filter: AlbumFilter, window: Window, limit: number) {
  return getDb()
    .select(itemColumns)
    .from(media)
    .where(
      and(
        eq(media.guestId, guestId),
        visibleAlbumItems(),
        sql`${media.status} = 'ready'`,
        ...filterConditions(filter),
        ...windowConditions(window),
      ),
    )
    .orderBy(desc(media.listedAt), desc(media.id))
    .limit(limit);
}

/**
 * One guest's own items not yet listed: uploaded (waiting for the worker) and failed, the newest
 * upload first, at most PENDING_LIMIT: read by index, then a sort of that guest's few such rows.
 * Exported so a test can check its plan.
 */
export function pendingQuery(guestId: string, filter: AlbumFilter, statuses: readonly ("uploaded" | "failed")[]) {
  return getDb()
    .select(itemColumns)
    .from(media)
    .where(
      and(
        eq(media.guestId, guestId),
        visibleAlbumItems(),
        statuses.length === 2 ? sql`${media.status} in ('uploaded', 'failed')` : sql`${media.status} = 'uploaded'`,
        ...filterConditions(filter),
      ),
    )
    .orderBy(desc(media.uploadedAt), desc(media.id))
    .limit(PENDING_LIMIT);
}

/** Newest first, as the indexes read: by listed_at, then id. Both are fixed-width text, so text order is theirs. */
function newestFirst(first: ItemRow, second: ItemRow): number {
  const byListed = (second.listedAt ?? "").localeCompare(first.listedAt ?? "");
  return byListed !== 0 ? byListed : second.id < first.id ? -1 : second.id > first.id ? 1 : 0;
}

function knownGuests(viewerGuestIds: readonly string[]): string[] {
  return [...new Set(viewerGuestIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))];
}

/** Listed rows for the filter: everyone's on one index, or each of the browser's guests' merged. */
async function listedRows(viewerGuestIds: readonly string[], filter: AlbumFilter, window: Window, limit: number): Promise<ItemRow[]> {
  if (!filter.mine) return (await everyoneQuery(filter, window, limit)) as ItemRow[];
  const guests = knownGuests(viewerGuestIds);
  const pages = await Promise.all(guests.map((guestId) => guestQuery(guestId, filter, window, limit)));
  return (pages.flat() as ItemRow[]).sort(newestFirst).slice(0, limit);
}

export type ListAlbumOptions = AlbumFilter & {
  /** Every guest the browser's cookie holds: its own items show as its own, and only it sees those not ready. */
  viewerGuestIds: readonly string[];
  /** Where the page starts; none for the first page. */
  cursor?: string | null;
  limit?: number;
};

/**
 * A page of the album, newest first, and where the next one starts. The first page also leads with
 * the browser's own items not yet listed: uploaded ones ("Getting it ready"), and in My uploads its
 * failed ones too, with their reason. A cursor this server didn't make reads as the first page.
 */
export async function listAlbum(options: ListAlbumOptions): Promise<AlbumPage> {
  const { viewerGuestIds, limit = ALBUM_PAGE_SIZE } = options;
  const filter: AlbumFilter = { celebration: options.celebration, kind: options.kind, mine: options.mine };
  const cursor = decodeCursor(options.cursor);
  const guests = knownGuests(viewerGuestIds);
  const [rows, pending] = await Promise.all([
    listedRows(guests, filter, { olderThan: cursor ?? undefined }, limit + 1),
    cursor || guests.length === 0
      ? Promise.resolve([] as ItemRow[])
      : Promise.all(guests.map((guestId) => pendingQuery(guestId, filter, filter.mine ? ["uploaded", "failed"] : ["uploaded"]))).then(
          (pages) => pages.flat() as ItemRow[],
        ),
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const newest = cursor ? null : page[0];
  // The browser's own items not listed yet lead, the newest upload first (each guest's come so; several guests' are merged).
  const waiting = pending.sort((first, second) => (second.uploadedAt?.getTime() ?? 0) - (first.uploadedAt?.getTime() ?? 0)).slice(0, PENDING_LIMIT);
  return {
    items: [...waiting, ...page].map((row) => toAlbumItem(row, guests)),
    nextCursor: rows.length > limit && last?.listedAt ? encodeCursor({ listedAt: last.listedAt, id: last.id }) : null,
    // An empty first page counts from the start, so its first moment shows in the pill too.
    newestCursor: cursor ? null : newest?.listedAt ? encodeCursor({ listedAt: newest.listedAt, id: newest.id }) : encodeCursor(ALBUM_START),
  };
}

/** The moments listed since a guest's newest, for the pill: all of them, or `complete: false` past NEWER_LIMIT. */
export type NewerPage = { items: AlbumItem[]; complete: boolean; newestCursor: string | null };

/** The moments listed after `since` (a page's newestCursor), newest first. Null for a cursor this server didn't make. */
export async function listNewer(
  options: AlbumFilter & { viewerGuestIds: readonly string[]; since: string },
): Promise<NewerPage | null> {
  const since = decodeCursor(options.since);
  if (!since) return null;
  const guests = knownGuests(options.viewerGuestIds);
  const filter: AlbumFilter = { celebration: options.celebration, kind: options.kind, mine: options.mine };
  const rows = await listedRows(guests, filter, { newerThan: since }, NEWER_LIMIT + 1);
  const page = rows.slice(0, NEWER_LIMIT);
  const newest = page[0];
  return {
    items: page.map((row) => toAlbumItem(row, guests)),
    complete: rows.length <= NEWER_LIMIT,
    newestCursor: newest?.listedAt ? encodeCursor({ listedAt: newest.listedAt, id: newest.id }) : options.since,
  };
}

/** The most new moments the check counts: past it the pill says "500+". */
export const NEW_COUNT_CAP = 500;

/** What the pill shows: how many (at most NEW_COUNT_CAP), and the newest few's thumbnails. */
export type NewCount = { count: number; newest: { id: string; thumb: string | null; color: string | null }[] };

/**
 * The query behind countNewSince: one query on media_album_cursor_idx, reading only the moments
 * listed after `since` (a short run at the index's start, never more than NEW_COUNT_CAP), counting
 * them and keeping the newest three. The cap keeps even a generic plan, which can't know how recent
 * `since` is, on the index in its own order, with no sort. Exported so a test can check its plan.
 */
export function newSinceQuery(since: AlbumCursor, filter: AlbumFilter, viewerGuestIds: readonly string[]) {
  const guests = knownGuests(viewerGuestIds);
  const listed = getDb()
    .select({
      id: media.id,
      kind: media.kind,
      derived: media.derived,
      averageColor: media.averageColor,
      listedAt: media.listedAt,
    })
    .from(media)
    .where(
      and(
        visibleAlbumItems(),
        sql`${media.status} = 'ready'`,
        ...filterConditions(filter),
        filter.mine ? (guests.length > 0 ? inArray(media.guestId, guests) : sql`false`) : undefined,
        ...windowConditions({ newerThan: since }),
      ),
    )
    .orderBy(desc(media.listedAt), desc(media.id))
    .limit(NEW_COUNT_CAP)
    .as("listed");
  return getDb()
    .select({
      id: listed.id,
      kind: listed.kind,
      derived: listed.derived,
      averageColor: listed.averageColor,
      total: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(listed)
    .orderBy(desc(listed.listedAt), desc(listed.id))
    .limit(3);
}

/**
 * How many moments the filter holds that were listed after `since` (a page's newestCursor), at most
 * NEW_COUNT_CAP, with the newest three's thumbnails. Null for a cursor this server didn't make.
 */
export async function countNewSince(
  since: string,
  filter: AlbumFilter,
  viewerGuestIds: readonly string[] = [],
): Promise<NewCount | null> {
  const cursor = decodeCursor(since);
  if (!cursor) return null;
  const rows = await newSinceQuery(cursor, filter, viewerGuestIds);
  return {
    count: rows[0]?.total ?? 0,
    newest: rows.map((row) => ({
      id: row.id,
      thumb: urlOf(row.kind === "video" ? row.derived["poster-thumb"] : row.derived.thumb),
      color: row.averageColor,
    })),
  };
}

/** Everyone's listed moments counted by celebration and kind, along media_album_cursor_idx. Exported for its plan's test. */
export function everyoneStatsQuery() {
  return getDb()
    .select({ celebration: media.celebration, kind: media.kind, count: sql<number>`count(*)`.mapWith(Number) })
    .from(media)
    .where(and(visibleAlbumItems(), sql`${media.status} = 'ready'`))
    .groupBy(media.celebration, media.kind);
}

/** One guest's own moments (listed, waiting or failed) counted by celebration and kind, along media_album_mine_idx. */
export function guestStatsQuery(guestId: string) {
  return getDb()
    .select({ celebration: media.celebration, kind: media.kind, count: sql<number>`count(*)`.mapWith(Number) })
    .from(media)
    .where(and(eq(media.guestId, guestId), visibleAlbumItems(), sql`${media.status} in ('ready', 'uploaded', 'failed')`))
    .groupBy(media.celebration, media.kind);
}

function asCounts(rows: { celebration: string; kind: string; count: number }[]): AlbumCount[] {
  return rows
    .filter((row) => row.kind === "photo" || row.kind === "video")
    .map((row) => ({ celebration: row.celebration as AlbumCelebration, kind: row.kind as AlbumKind, count: row.count }));
}

/**
 * The album's counts, for the count line ("214 moments", "38 videos") and the chips ("More moments"
 * only once it holds something): everyone's listed moments, and the browser's own (its items not
 * ready yet included, as My uploads shows them).
 */
export async function albumStats(viewerGuestIds: readonly string[] = []): Promise<AlbumStats> {
  const guests = knownGuests(viewerGuestIds);
  const [everyone, ...own] = await Promise.all([everyoneStatsQuery(), ...guests.map((guestId) => guestStatsQuery(guestId))]);
  const mine = new Map<string, AlbumCount>();
  for (const count of asCounts(own.flat())) {
    const key = `${count.celebration}/${count.kind}`;
    const known = mine.get(key);
    mine.set(key, { ...count, count: (known?.count ?? 0) + count.count });
  }
  return { everyone: asCounts(everyone), mine: [...mine.values()] };
}

/**
 * One item for the viewer and the uploader (GET /api/media/[id]): a listed, visible album item, or
 * one of the browser's own not yet listed (uploaded or failed), so its state shows. Null otherwise.
 * One read on the primary key.
 */
export async function findAlbumItem(mediaId: string, viewerGuestIds: readonly string[]): Promise<AlbumItem | null> {
  if (!isUuid(mediaId)) return null;
  const guests = knownGuests(viewerGuestIds);
  const [row] = await getDb()
    .select(itemColumns)
    .from(media)
    .where(
      and(
        eq(media.id, mediaId),
        visibleAlbumItems(),
        sql`${media.status} in ('ready', 'uploaded', 'failed')`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const own = row.guestId !== null && guests.includes(row.guestId);
  if (row.status !== "ready" && !own) return null;
  return toAlbumItem(row as ItemRow, guests);
}

/** The most moments one batched read names. */
export const MAX_ITEMS_PER_READ = 50;

/**
 * Several moments at once, each as findAlbumItem would answer it (absent when it would be null), in
 * one query on the primary key: the album's waiting tiles and the uploader's cards ask after all of
 * theirs in one request (fix round 1, Important #2). At most MAX_ITEMS_PER_READ ids; any that aren't
 * one are skipped.
 */
export async function findAlbumItems(mediaIds: readonly string[], viewerGuestIds: readonly string[]): Promise<AlbumItem[]> {
  const ids = [...new Set(mediaIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))].slice(0, MAX_ITEMS_PER_READ);
  if (ids.length === 0) return [];
  const guests = knownGuests(viewerGuestIds);
  const rows = (await getDb()
    .select(itemColumns)
    .from(media)
    .where(and(inArray(media.id, ids), visibleAlbumItems(), sql`${media.status} in ('ready', 'uploaded', 'failed')`))) as ItemRow[];
  return rows
    .filter((row) => row.status === "ready" || (row.guestId !== null && guests.includes(row.guestId)))
    .map((row) => toAlbumItem(row, guests));
}

/** What the download route reads of an item: a ready, visible album item's files. */
export type DownloadableItem = {
  id: string;
  kind: "photo" | "video";
  celebration: AlbumCelebration;
  originalKey: string;
  contentType: string;
  sizeBytes: number;
  derived: Partial<Record<string, string>>;
};

/** A ready, visible album item, for a download; null otherwise (hidden, removed, not ready, a wish). One read on the primary key. */
export async function findDownloadable(mediaId: string): Promise<DownloadableItem | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .select({
      id: media.id,
      kind: media.kind,
      celebration: media.celebration,
      originalKey: media.originalKey,
      contentType: media.contentType,
      sizeBytes: media.sizeBytes,
      derived: media.derived,
    })
    .from(media)
    .where(and(eq(media.id, mediaId), visibleAlbumItems(), sql`${media.status} = 'ready'`))
    .limit(1);
  if (!row || (row.kind !== "photo" && row.kind !== "video")) return null;
  return row as DownloadableItem;
}

/** Whether a photo is an iPhone's HEIC or HEIF, which also downloads as a JPEG. */
export function isHeic(item: Pick<DownloadableItem, "kind" | "contentType">): boolean {
  return item.kind === "photo" && HEIC_TYPES.has(item.contentType);
}

