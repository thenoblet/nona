import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { publicUrl } from "@/lib/storage/keys";
import type { AdminWish, AdminWishPage } from "./admin-item";
import { deletableFrom } from "./moderation";
import { decodeTimeCursor, encodeTimeCursor, microsecondText, type TimeCursor } from "./time-cursor";

/*
 * The admin's Wishes tab (Task 17): every wish but the deleted, hidden ones too, newest first, along
 * wishes_admin_idx, paged by a cursor; a voice or video wish's recording read beside it by primary
 * key, for its state, its lock and the file the wall plays, which the couple play here (Task 16).
 */

/** A page's size. */
export const ADMIN_WISHES_PAGE_SIZE = 50;

const wishColumns = {
  id: wishes.id,
  kind: wishes.kind,
  message: wishes.message,
  signedAs: wishes.signedAs,
  createdAt: wishes.createdAt,
  createdAtText: microsecondText(wishes.createdAt),
  hiddenAt: wishes.hiddenAt,
  hiddenBy: wishes.hiddenBy,
  mediaId: wishes.mediaId,
  recordingKind: media.kind,
  recordingStatus: media.status,
  recordingSeconds: media.durationSeconds,
  recordingUploadedAt: media.uploadedAt,
  recordingDerived: media.derived,
  recordingVisible: sql<boolean | null>`${media.hiddenAt} is null and ${media.deletedAt} is null and not ${media.removedByUploader}`,
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
  recordingDerived: Partial<Record<string, string>> | null;
  recordingVisible: boolean | null;
};

/**
 * What the couple play of a recording: the file the wall plays (a voice note's M4A, a video
 * message's MP4) and a video's poster, once media.wish has made them, while it is visible; none
 * while it is being made, after it failed, or once hidden (its files are withdrawn: its original
 * still opens). The poster is the 480 px one the wall shows: a <video> fetches its poster whatever
 * its preload says, and a page holds 50 wishes, on the couple's phone too.
 */
function playableOf(row: WishRow): { url: string | null; poster: string | null } {
  const ready = row.recordingStatus === "ready" && row.recordingVisible === true;
  const played = row.kind === "voice" ? row.recordingDerived?.audio : row.recordingDerived?.video;
  const poster = row.recordingDerived?.["poster-thumb"];
  if (!ready || !played) return { url: null, poster: null };
  return { url: publicUrl(played), poster: poster ? publicUrl(poster) : null };
}

/** A page of the admin's wishes along wishes_admin_idx. Exported so a test can check its plan. */
export function adminWishesQuery(cursor: TimeCursor | null, limit: number) {
  return getDb()
    .select(wishColumns)
    .from(wishes)
    .leftJoin(media, eq(media.id, wishes.mediaId))
    .where(
      and(
        isNull(wishes.deletedAt),
        cursor ? sql`(${wishes.createdAt}, ${wishes.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
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
            ...playableOf(row),
          }
        : null,
    deletableFrom: lockedUntil?.toISOString() ?? null,
    deletable: lockedUntil === null || Date.now() >= lockedUntil.getTime(),
  };
}

/** A page of the admin's wishes, newest first. A cursor this server didn't make reads as the first page. */
export async function listAdminWishes(options: { cursor?: string | null; limit?: number }): Promise<AdminWishPage> {
  const limit = options.limit ?? ADMIN_WISHES_PAGE_SIZE;
  const rows = (await adminWishesQuery(decodeTimeCursor(options.cursor), limit + 1)) as WishRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    wishes: page.map(toAdminWish),
    nextCursor: rows.length > limit && last ? encodeTimeCursor({ at: last.createdAtText, id: last.id }) : null,
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
