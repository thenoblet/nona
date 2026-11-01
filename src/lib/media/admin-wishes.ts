import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import type { AdminWish, AdminWishPage } from "./admin-item";
import { deletableFrom } from "./moderation";

/*
 * The admin's Wishes tab (Task 17): every wish but the deleted, hidden ones too, newest first, along
 * wishes_admin_idx, paged by a cursor; a voice or video wish's recording read beside it by primary
 * key, for its state and its lock (Task 16 plays it there).
 */

/** A page's size. */
export const ADMIN_WISHES_PAGE_SIZE = 50;

export type AdminWishCursor = { createdAt: string; id: string };

const TIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeWishCursor(cursor: AdminWishCursor): string {
  return Buffer.from(`${cursor.createdAt}~${cursor.id}`).toString("base64url");
}

/** The cursor a page sent, or null when it isn't one this server made. */
export function decodeWishCursor(value: string | null | undefined): AdminWishCursor | null {
  if (!value || value.length > 200) return null;
  const [createdAt, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("~");
  if (rest.length > 0 || !createdAt || !id || !TIME_TEXT.test(createdAt) || !isUuid(id)) return null;
  return { createdAt, id: id.toLowerCase() };
}

const wishColumns = {
  id: wishes.id,
  kind: wishes.kind,
  message: wishes.message,
  signedAs: wishes.signedAs,
  createdAt: wishes.createdAt,
  createdAtText: sql<string>`to_char(${wishes.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  hiddenAt: wishes.hiddenAt,
  hiddenBy: wishes.hiddenBy,
  mediaId: wishes.mediaId,
  recordingKind: media.kind,
  recordingStatus: media.status,
  recordingSeconds: media.durationSeconds,
  recordingUploadedAt: media.uploadedAt,
};

type WishRow = {
  id: string;
  kind: "text" | "voice" | "video";
  message: string | null;
  signedAs: string;
  createdAt: Date;
  createdAtText: string;
  hiddenAt: Date | null;
  hiddenBy: string | null;
  mediaId: string | null;
  recordingKind: "photo" | "video" | "audio" | null;
  recordingStatus: "uploading" | "uploaded" | "ready" | "failed" | null;
  recordingSeconds: number | null;
  recordingUploadedAt: Date | null;
};

/** A page of the admin's wishes along wishes_admin_idx. Exported so a test can check its plan. */
export function adminWishesQuery(cursor: AdminWishCursor | null, limit: number) {
  return getDb()
    .select(wishColumns)
    .from(wishes)
    .leftJoin(media, eq(media.id, wishes.mediaId))
    .where(
      and(
        isNull(wishes.deletedAt),
        cursor ? sql`(${wishes.createdAt}, ${wishes.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(wishes.createdAt), desc(wishes.id))
    .limit(limit);
}

function toAdminWish(row: WishRow): AdminWish {
  // A recording is under the originals' lock; a written wish has none.
  const lockedUntil = row.mediaId ? deletableFrom(row.recordingUploadedAt ?? row.createdAt) : null;
  return {
    id: row.id,
    kind: row.kind,
    message: row.kind === "text" ? row.message : null,
    signedAs: row.signedAs,
    createdAt: row.createdAt.toISOString(),
    hiddenAt: row.hiddenAt?.toISOString() ?? null,
    hiddenBy: row.hiddenBy,
    recording:
      row.mediaId && row.recordingKind && row.recordingStatus
        ? {
            mediaId: row.mediaId,
            kind: row.recordingKind,
            status: row.recordingStatus,
            seconds: row.recordingSeconds === null ? null : Math.round(row.recordingSeconds),
          }
        : null,
    deletableFrom: lockedUntil?.toISOString() ?? null,
    deletable: lockedUntil === null || Date.now() >= lockedUntil.getTime(),
  };
}

/** A page of the admin's wishes, newest first. A cursor this server didn't make reads as the first page. */
export async function listAdminWishes(options: { cursor?: string | null; limit?: number }): Promise<AdminWishPage> {
  const limit = options.limit ?? ADMIN_WISHES_PAGE_SIZE;
  const rows = (await adminWishesQuery(decodeWishCursor(options.cursor), limit + 1)) as WishRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    wishes: page.map(toAdminWish),
    nextCursor: rows.length > limit && last ? encodeWishCursor({ createdAt: last.createdAtText, id: last.id }) : null,
  };
}

/** One wish as an action leaves it; null when it is deleted or isn't there. */
export async function findAdminWish(wishId: string): Promise<AdminWish | null> {
  if (!isUuid(wishId)) return null;
  const [row] = (await getDb()
    .select(wishColumns)
    .from(wishes)
    .leftJoin(media, eq(media.id, wishes.mediaId))
    .where(and(eq(wishes.id, wishId.toLowerCase()), isNull(wishes.deletedAt)))
    .limit(1)) as WishRow[];
  return row ? toAdminWish(row) : null;
}

/** How many wishes the tab holds: every one but the deleted. */
export async function countAdminWishes(): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(wishes)
    .where(isNull(wishes.deletedAt));
  return row?.count ?? 0;
}
