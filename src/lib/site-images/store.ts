import { and, desc, eq, sql } from "drizzle-orm";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media, siteImages, type MEDIA_STATUSES } from "@/lib/db/schema";
import type { DerivedVariant } from "@/lib/storage/keys";
import { clampFraction, type Focal } from "./focal";

/*
 * The site_images table's queries, shared by the app (the guest pages' reads, the admin's saves) and
 * the media worker (the preview cards). Every save adds a row; the newest row per slot is live
 * (site_images_slot_newest_idx, slot then saved_at and id newest first), and restoring an older one
 * saves it again as the newest. A row with no media is the slot's built-in photo, its alt text and
 * focal point as the couple edited them. Nothing here imports from next/: the worker bundles it.
 */

type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** A site photo's media row, as the pages and the cards need it. */
export type SitePhotoFile = {
  status: MediaStatus;
  width: number | null;
  height: number | null;
  derived: Partial<Record<DerivedVariant, string>>;
  averageColor: string | null;
};

/** One saved row of a slot, with its photo's file when it has one. */
export type SiteImageRow = {
  id: string;
  slot: string;
  /** Null: the slot's built-in photo. */
  mediaId: string | null;
  alt: string;
  focal: Focal;
  /** The worker-drawn preview card's key in the public bucket, once drawn (preview slots only). */
  cardKey: string | null;
  savedBy: string;
  savedAt: Date;
  photo: SitePhotoFile | null;
};

const rowColumns = {
  id: siteImages.id,
  slot: siteImages.slot,
  mediaId: siteImages.mediaId,
  alt: siteImages.alt,
  focalX: siteImages.focalX,
  focalY: siteImages.focalY,
  cardKey: siteImages.cardKey,
  savedBy: siteImages.savedBy,
  savedAt: siteImages.savedAt,
  status: media.status,
  width: media.width,
  height: media.height,
  derived: media.derived,
  averageColor: media.averageColor,
};

type SelectedRow = {
  id: string;
  slot: string;
  mediaId: string | null;
  alt: string;
  focalX: number;
  focalY: number;
  cardKey: string | null;
  savedBy: string;
  savedAt: Date;
  status: MediaStatus | null;
  width: number | null;
  height: number | null;
  derived: Partial<Record<DerivedVariant, string>> | null;
  averageColor: string | null;
};

function toRow(selected: SelectedRow): SiteImageRow {
  return {
    id: selected.id,
    slot: selected.slot,
    mediaId: selected.mediaId,
    alt: selected.alt,
    focal: { x: selected.focalX, y: selected.focalY },
    cardKey: selected.cardKey,
    savedBy: selected.savedBy,
    savedAt: selected.savedAt,
    photo:
      selected.mediaId && selected.status
        ? {
            status: selected.status,
            width: selected.width,
            height: selected.height,
            derived: selected.derived ?? {},
            averageColor: selected.averageColor,
          }
        : null,
  };
}

/** The newest row of every slot that has one: what the site shows. One read of the slot index, a primary-key join each. */
export async function readLiveSiteImages(): Promise<SiteImageRow[]> {
  const rows = await getDb()
    .selectDistinctOn([siteImages.slot], rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .orderBy(siteImages.slot, desc(siteImages.savedAt), desc(siteImages.id));
  return rows.map(toRow);
}

/** Every row, newest first: the admin's slots and each one's earlier photos. The couple's own saves, so a short table. */
export async function readAllSiteImages(): Promise<SiteImageRow[]> {
  const rows = await getDb()
    .select(rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .orderBy(siteImages.slot, desc(siteImages.savedAt), desc(siteImages.id));
  return rows.map(toRow);
}

/** One slot's rows, newest first (the first is live). */
export async function readSiteImages(slot: string): Promise<SiteImageRow[]> {
  const rows = await getDb()
    .select(rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .where(eq(siteImages.slot, slot))
    .orderBy(desc(siteImages.savedAt), desc(siteImages.id));
  return rows.map(toRow);
}

/** The slot's live row, or null while it shows its built-in photo unedited. */
export async function readLiveSiteImage(slot: string): Promise<SiteImageRow | null> {
  const [row] = await getDb()
    .select(rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .where(eq(siteImages.slot, slot))
    .orderBy(desc(siteImages.savedAt), desc(siteImages.id))
    .limit(1);
  return row ? toRow(row) : null;
}

/** A row by its id. */
export async function readSiteImage(id: string): Promise<SiteImageRow | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .select(rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .where(eq(siteImages.id, id))
    .limit(1);
  return row ? toRow(row) : null;
}

export type NewSiteImage = {
  slot: string;
  /** Null: the slot's built-in photo. */
  mediaId: string | null;
  alt: string;
  focal: Focal;
  savedBy: string;
};

/**
 * Saves a slot: a new row, live at once. A save that keeps the live row's photo and focal point
 * (an edit of its alt text) keeps its preview card too, so the card never drops back to the
 * built-in one while the worker would draw the same picture again. `now` defaults to the
 * database's clock; a test passes its own to order saves.
 */
export async function saveSiteImage(image: NewSiteImage, now?: Date): Promise<SiteImageRow> {
  const focal = { x: clampFraction(image.focal.x), y: clampFraction(image.focal.y) };
  const live = await readLiveSiteImage(image.slot);
  const samePicture = live !== null && live.mediaId === image.mediaId && live.focal.x === focal.x && live.focal.y === focal.y;
  const [inserted] = await getDb()
    .insert(siteImages)
    .values({
      slot: image.slot,
      mediaId: image.mediaId,
      alt: image.alt.trim(),
      focalX: focal.x,
      focalY: focal.y,
      cardKey: samePicture ? live.cardKey : null,
      savedBy: image.savedBy,
      ...(now ? { savedAt: now } : {}),
    })
    .returning({ id: siteImages.id });
  const saved = await readSiteImage(inserted.id);
  if (!saved) throw new Error("A saved site image wasn't there to read back");
  return saved;
}

/**
 * Makes an earlier row live again: saved again as the newest, with its photo, alt text, focal point
 * and preview card. Null when there is no such row.
 */
export async function restoreSiteImage(id: string, savedBy: string, now?: Date): Promise<SiteImageRow | null> {
  const earlier = await readSiteImage(id);
  if (!earlier) return null;
  const [inserted] = await getDb()
    .insert(siteImages)
    .values({
      slot: earlier.slot,
      mediaId: earlier.mediaId,
      alt: earlier.alt,
      focalX: earlier.focal.x,
      focalY: earlier.focal.y,
      cardKey: earlier.cardKey,
      savedBy,
      ...(now ? { savedAt: now } : {}),
    })
    .returning({ id: siteImages.id });
  return readSiteImage(inserted.id);
}

/** Whether the row is its slot's newest: only the live row's card is drawn (a newer save sends its own job). */
export async function isLiveSiteImage(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  // The newest row is the greatest (saved_at, id), as readLiveSiteImages orders them.
  const result = await getDb().execute<{ live: boolean }>(sql`
    select not exists (
      select 1 from site_images newer
      where newer.slot = row.slot and (newer.saved_at, newer.id) > (row.saved_at, row.id)
    ) as live
    from site_images row
    where row.id = ${id}`);
  return result[0]?.live === true;
}

/** Records the row's drawn card. False when the row is gone. */
export async function setCardKey(id: string, cardKey: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const updated = await getDb()
    .update(siteImages)
    .set({ cardKey })
    .where(eq(siteImages.id, id))
    .returning({ id: siteImages.id });
  return updated.length > 0;
}

/** A photo the couple uploaded for the site (purpose "site"), by its media id: what the admin's editor needs of it. */
export async function readSiteUpload(mediaId: string): Promise<(SitePhotoFile & { id: string; failureReason: string | null }) | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .select({
      id: media.id,
      status: media.status,
      failureReason: media.failureReason,
      width: media.width,
      height: media.height,
      derived: media.derived,
      averageColor: media.averageColor,
    })
    .from(media)
    .where(and(eq(media.id, mediaId), eq(media.purpose, "site"), sql`${media.deletedAt} is null`))
    .limit(1);
  return row ?? null;
}
