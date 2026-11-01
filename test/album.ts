import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { originalKey } from "@/lib/storage/keys";

/*
 * Album rows for tests (Task 15): an item as the worker leaves it, against the test database.
 */

export type AlbumRow = typeof media.$inferInsert;

/** The derived keys a photo's processing names. */
export function photoKeys(mediaId: string): Record<string, string> {
  return { thumb: `derived/${mediaId}/0123456789abcdef/thumb.webp`, view: `derived/${mediaId}/0123456789abcdef/view.webp` };
}

/** The derived keys a video's poster job names (its thumbnail and viewing size). */
export function posterKeys(mediaId: string): Record<string, string> {
  return {
    "poster-thumb": `derived/${mediaId}/0123456789abcdef/poster-thumb.webp`,
    "poster-view": `derived/${mediaId}/0123456789abcdef/poster-view.webp`,
  };
}

/**
 * Inserts an album item, by default a ready photo listed at `listedAt` (now, by the database's
 * clock, when not given), and returns its id. A listed time may be given to the microsecond as
 * text ("2026-12-05 18:00:05.123456+00"), or as so many seconds before now by the database's clock.
 */
export async function addAlbumItem(
  overrides: Partial<AlbumRow> & { listedAtText?: string; listedSecondsAgo?: number } = {},
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const { listedAtText, listedSecondsAgo, ...row } = overrides;
  const kind = row.kind ?? "photo";
  const status = row.status ?? "ready";
  const listed = status === "ready";
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind,
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "reception",
      originalKey: originalKey(id, kind === "video" ? "mov" : "jpg"),
      originalFilename: kind === "video" ? "IMG_0001.MOV" : "IMG_0001.JPG",
      sizeBytes: kind === "video" ? 84_000_000 : 4_200_000,
      contentType: kind === "video" ? "video/quicktime" : "image/jpeg",
      status,
      uploadedAt: new Date("2026-12-05T18:00:00Z"),
      derived: status === "ready" ? (kind === "video" ? posterKeys(id) : photoKeys(id)) : {},
      width: status === "ready" ? 1200 : null,
      height: status === "ready" ? 1600 : null,
      thumbhash: status === "ready" ? "1QcSHQRnh493V4dIh4eXh1h4kJUI" : null,
      averageColor: status === "ready" ? "#a08070" : null,
      ...row,
      listedAt: listedAtText
        ? sql`${listedAtText}::timestamptz`
        : listedSecondsAgo !== undefined
          ? sql`clock_timestamp() - make_interval(secs => ${listedSecondsAgo})`
          : (row.listedAt ?? (listed ? sql`clock_timestamp()` : null)),
    } as AlbumRow);
  return id;
}

/** Marks an item ready now, as the worker does (listed now if it wasn't). */
export async function markReadyNow(mediaId: string): Promise<void> {
  await getDb().execute(
    sql`update media set status = 'ready', listed_at = coalesce(listed_at, clock_timestamp()) where id = ${mediaId}`,
  );
}
