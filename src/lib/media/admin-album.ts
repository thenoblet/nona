import "server-only";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { RETIRED_EVENT_ID, type EventId } from "@/lib/content/schema";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { adminScopeOf, adminStateOf, media, type AdminStateName } from "@/lib/db/schema";
import { publicUrl } from "@/lib/storage/keys";
import { albumCelebrationOf } from "./album-item";
import {
  ADMIN_CHIPS,
  type AdminChip,
  type AdminCountRow,
  type AdminFilter,
  type AdminItem,
  type AdminPage,
} from "./admin-item";
import { deletableFrom } from "./moderation";
import { decodeTimeCursor, encodeTimeCursor, microsecondText, newestFirst, type TimeCursor } from "./time-cursor";

/*
 * The admin's album (Task 17, Ruling BW): every album item that finished uploading, hidden and
 * removed ones too, newest upload first, the id breaking ties; filtered by a state chip, a
 * celebration, a kind and who shared it; paged by a cursor; and counted per chip in one grouped
 * query. Deleted tombstones never show.
 *
 * Every query reads an index and never sorts (the EXPLAIN tests in admin-album.test.ts):
 * - A page's ids come from one media_admin_* index in its own order, the filters checked on the
 *   index's own columns (an index-only scan), and only that page's rows are then read, by primary
 *   key, in a nested loop that keeps the order.
 * - The search of who shared it walks media_admin_idx in order, checking each entry's uploader_name
 *   case-insensitively, and stops at a page: the index carries the name, so the table is never read
 *   for the rows it passes over. A trigram index could find the names faster, but it can't give
 *   them newest first, and the page would be sorted; this way nothing is, and a search of one or
 *   two letters works too.
 * - The state chips compare adminStateOf (media_admin_state_idx's own expression) with a literal,
 *   and Highlights reads media_admin_highlight_idx.
 * - The counts group media_admin_counts_idx's entries by celebration and kind, in its order, a few
 *   rows the page sums.
 * Conditions the indexes' predicates name are written as literals (adminScopeOf), never bound
 * values, so a generic plan, as a pooled prepared statement gets, can still prove they apply.
 *
 * An item stored as the retired thanksgiving is listed, counted and named under More moments, as
 * the album shows it (albumCelebrationOf), its row left as it is. More moments is read twice, once
 * for "more" and once for the thanksgiving, each along media_admin_celebration_idx in its own
 * order, and the two merged: one read of both values would have to sort, or walk media_admin_idx
 * whole to find a few dozen items (adminReads).
 */

/** A page's size. */
export const ADMIN_PAGE_SIZE = 30;

/** A search as an ILIKE pattern: anywhere in the name, its % and _ (and \) meant literally. */
function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** The chip's condition. A state chip is a literal from our own list, so the expression index matches. */
function chipCondition(chip: AdminChip): SQL {
  if (chip === "highlights") return sql`${media.highlight}`;
  if (!(ADMIN_CHIPS as readonly string[]).includes(chip)) throw new RangeError(`Refusing ${JSON.stringify(chip)} as a chip`);
  return sql`${adminStateOf(media)} = ${sql.raw(`'${chip}'`)}`;
}

/** One read of the admin's album: the filter, its celebration as stored. */
export type AdminRead = Omit<AdminFilter, "celebration"> & { celebration?: EventId | "more" };

/**
 * The reads a filter's page is made of: the filter itself, or for More moments one read of "more"
 * and one of the retired thanksgiving, which listAdminAlbum merges.
 */
export function adminReads(filter: AdminFilter): AdminRead[] {
  return filter.celebration === "more" ? [filter, { ...filter, celebration: RETIRED_EVENT_ID }] : [filter];
}

function filterConditions(read: AdminRead): (SQL | undefined)[] {
  return [
    read.chip ? chipCondition(read.chip) : undefined,
    read.celebration ? eq(media.celebration, read.celebration) : undefined,
    read.kind ? eq(media.kind, read.kind) : undefined,
    read.search ? sql`${media.uploaderName} ilike ${containsPattern(read.search)}` : undefined,
  ];
}

/** The row each page item is read from: its own alias, so the page's ids and its rows are two scans of media. */
const item = alias(media, "item");

const itemColumns = {
  id: item.id,
  kind: item.kind,
  state: adminStateOf(item).as("state"),
  guestId: item.guestId,
  uploaderName: item.uploaderName,
  celebration: item.celebration,
  uploadedAt: item.uploadedAt,
  uploadedAtText: microsecondText(item.uploadedAt).as("uploaded_at_text"),
  capturedAt: item.capturedAt,
  hiddenAt: item.hiddenAt,
  hiddenBy: item.hiddenBy,
  highlight: item.highlight,
  status: item.status,
  failureReason: item.failureReason,
  conversion: item.conversion,
  conversionFailureReason: item.conversionFailureReason,
  width: item.width,
  height: item.height,
  durationSeconds: item.durationSeconds,
  thumbhash: item.thumbhash,
  averageColor: item.averageColor,
  derived: item.derived,
  contentType: item.contentType,
  sizeBytes: item.sizeBytes,
  originalKey: item.originalKey,
};

type ItemRow = {
  id: string;
  kind: "photo" | "video" | "audio";
  state: AdminStateName | null;
  guestId: string | null;
  uploaderName: string | null;
  celebration: EventId | "more";
  uploadedAt: Date | null;
  uploadedAtText: string;
  capturedAt: Date | null;
  hiddenAt: Date | null;
  hiddenBy: string | null;
  highlight: boolean;
  status: string;
  failureReason: string | null;
  conversion: string;
  conversionFailureReason: string | null;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  thumbhash: string | null;
  averageColor: string | null;
  derived: Partial<Record<string, string>>;
  contentType: string;
  sizeBytes: number;
  originalKey: string;
};

type ItemColumnName = keyof typeof itemColumns;

/**
 * A page of one read of the admin's album: the ids from a media_admin_* index, in its order, then
 * each one's row by primary key. The row is a lateral subquery of the page's id, so it is always
 * read per id (a nested loop on media_pkey, which keeps the page's order); a plain join could be
 * hashed, the table read whole, and the page sorted, as a generic plan can't know the page is short
 * (it takes a bound LIMIT for a tenth of the table). Exported so a test can check its plan.
 */
export function adminPageQuery(read: AdminRead, cursor: TimeCursor | null, limit: number) {
  const page = getDb()
    .select({ id: media.id, uploadedAt: media.uploadedAt })
    .from(media)
    .where(
      and(
        adminScopeOf(media),
        ...filterConditions(read),
        cursor ? sql`(${media.uploadedAt}, ${media.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(media.uploadedAt), desc(media.id))
    .limit(limit)
    .as("page");
  // limit 1 keeps Postgres from flattening the subquery into a join it could hash (the id is the
  // primary key, so there is only ever one row anyway).
  const row = getDb().select(itemColumns).from(item).where(eq(item.id, page.id)).limit(1).as("row");
  const rowColumns = Object.fromEntries(
    (Object.keys(itemColumns) as ItemColumnName[]).map((name) => [name, row[name]]),
  ) as { [Name in ItemColumnName]: (typeof row)[Name] };
  return getDb()
    .select(rowColumns)
    .from(page)
    .innerJoinLateral(row, sql`true`)
    .orderBy(desc(page.uploadedAt), desc(page.id));
}

/** One item of the admin's album by its id, read on the primary key. */
function oneItemQuery(mediaId: string) {
  return getDb()
    .select(itemColumns)
    .from(item)
    .where(and(eq(item.id, mediaId), adminScopeOf(item)))
    .limit(1);
}

/**
 * How many album items each of these guests has shared (deleted ones aside), in one query on
 * media_guest_id_idx. Exported so a test can check its plan.
 */
export function guestUploadsQuery(guestIds: readonly string[]) {
  return getDb()
    .select({ guestId: media.guestId, count: sql<number>`count(*)`.mapWith(Number) })
    .from(media)
    .where(and(inArray(media.guestId, [...guestIds]), adminScopeOf(media)))
    .groupBy(media.guestId);
}

async function uploadsByGuest(rows: readonly ItemRow[]): Promise<Map<string, number>> {
  const guestIds = [...new Set(rows.map((row) => row.guestId).filter((guestId): guestId is string => guestId !== null))];
  if (guestIds.length === 0) return new Map();
  const counts = await guestUploadsQuery(guestIds);
  return new Map(counts.map((count) => [count.guestId as string, count.count]));
}

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

function toAdminItem(row: ItemRow, uploads: Map<string, number>): AdminItem {
  const video = row.kind === "video";
  // A hidden or removed item's public files are deleted (or being deleted) by design: the admin
  // shows its ThumbHash, never a URL that answers 404 (Ruling BV).
  const withdrawn = row.state === "hidden" || row.state === "removed";
  const uploadedAt = row.uploadedAt ?? new Date(0);
  const failure =
    row.status === "failed"
      ? ({ during: "processing", reason: row.failureReason } as const)
      : row.status === "ready" && row.conversion === "failed"
        ? ({ during: "conversion", reason: row.conversionFailureReason } as const)
        : null;
  return {
    id: row.id,
    kind: video ? "video" : "photo",
    state: row.state,
    by: row.uploaderName,
    uploads: row.guestId ? (uploads.get(row.guestId) ?? null) : null,
    celebration: albumCelebrationOf(row.celebration),
    uploadedAt: uploadedAt.toISOString(),
    takenAt: row.capturedAt?.toISOString() ?? null,
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    hiddenBy: row.hiddenBy,
    highlight: row.highlight,
    width: row.width,
    height: row.height,
    seconds: video && row.durationSeconds !== null ? Math.round(row.durationSeconds) : null,
    thumbhash: row.thumbhash,
    color: row.averageColor,
    thumb: withdrawn ? null : urlOf(video ? row.derived["poster-thumb"] : row.derived.thumb),
    view: withdrawn ? null : urlOf(video ? row.derived["poster-view"] : row.derived.view),
    failure,
    original: { type: originalType(row.originalKey), bytes: row.sizeBytes, heic: !video && HEIC_TYPES.has(row.contentType) },
    deletableFrom: deletableFrom(uploadedAt).toISOString(),
    deletable: Date.now() >= deletableFrom(uploadedAt).getTime(),
  };
}

export type ListAdminAlbumOptions = { filter: AdminFilter; cursor?: string | null; limit?: number };

/** Newest upload first, as the admin's indexes read: by uploaded_at, then id. */
const newestUploadFirst = newestFirst((row: ItemRow) => row.uploadedAtText);

/**
 * A page of the admin's album for the filter, newest upload first. A cursor this server didn't make
 * reads as the first page. Each of the filter's reads (adminReads) gives at most a page and one
 * more, in order; merged, their first page and one more are the album's.
 */
export async function listAdminAlbum(options: ListAdminAlbumOptions): Promise<AdminPage> {
  const limit = options.limit ?? ADMIN_PAGE_SIZE;
  const cursor = decodeTimeCursor(options.cursor);
  const pages = await Promise.all(adminReads(options.filter).map((read) => adminPageQuery(read, cursor, limit + 1)));
  const rows = (pages.flat() as ItemRow[]).sort(newestUploadFirst).slice(0, limit + 1);
  const page = rows.slice(0, limit);
  const uploads = await uploadsByGuest(page);
  const last = page.at(-1);
  return {
    items: page.map((row) => toAdminItem(row, uploads)),
    nextCursor: rows.length > limit && last ? encodeTimeCursor({ at: last.uploadedAtText, id: last.id }) : null,
  };
}

/**
 * Whether the id names an item of the admin's album: not a wish's recording, a site photo, a
 * tombstone or an upload still under way. One read on the primary key, before an action changes it.
 */
export async function isAdminItem(mediaId: string): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const [row] = await getDb()
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.id, mediaId.toLowerCase()), adminScopeOf(media)))
    .limit(1);
  return row !== undefined;
}

/** One item of the admin's album, as an action leaves it; null when it isn't one (deleted, a wish, never uploaded). */
export async function findAdminItem(mediaId: string): Promise<AdminItem | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = (await oneItemQuery(mediaId.toLowerCase())) as ItemRow[];
  if (!row) return null;
  return toAdminItem(row, await uploadsByGuest([row]));
}

/**
 * The album counted per celebration and kind, each chip's count beside the total, in one grouped
 * query that reads media_admin_counts_idx alone. Exported so a test can check its plan.
 */
export function adminCountsQuery() {
  const state = adminStateOf(media);
  const countOf = (condition: SQL) => sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  return getDb()
    .select({
      celebration: media.celebration,
      kind: media.kind,
      total: sql<number>`count(*)`.mapWith(Number),
      failed: countOf(sql`${state} = 'failed'`),
      processing: countOf(sql`${state} = 'processing'`),
      converting: countOf(sql`${state} = 'converting'`),
      queued: countOf(sql`${state} = 'queued'`),
      hidden: countOf(sql`${state} = 'hidden'`),
      removed: countOf(sql`${state} = 'removed'`),
      highlights: countOf(sql`${media.highlight}`),
    })
    .from(media)
    .where(adminScopeOf(media))
    .groupBy(media.celebration, media.kind);
}

/**
 * The album's counts, per celebration and kind as the admin shows them (countsFor sums them for the
 * filter shown): those stored as the thanksgiving summed into More moments.
 */
export async function readAdminCounts(): Promise<AdminCountRow[]> {
  const counts = new Map<string, AdminCountRow>();
  for (const row of await adminCountsQuery()) {
    if (row.kind !== "photo" && row.kind !== "video") continue;
    const celebration = albumCelebrationOf(row.celebration);
    const key = `${celebration}/${row.kind}`;
    const known = counts.get(key);
    if (!known) {
      counts.set(key, { ...row, celebration, kind: row.kind });
      continue;
    }
    known.total += row.total;
    for (const chip of ADMIN_CHIPS) known[chip] += row[chip];
  }
  return [...counts.values()];
}
