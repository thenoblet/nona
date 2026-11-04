import { and, desc, eq, isNull, sql } from "drizzle-orm";
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

/**
 * A site photo's media row, joined only while it may be shown: never one hidden or deleted. Site
 * photos are outside the moderation's reach today (adminScopeOf is the album's), so this is a defence.
 */
const shownMedia = and(eq(media.id, siteImages.mediaId), isNull(media.hiddenAt), isNull(media.deletedAt));

/**
 * The newest row of every slot that has one: what the site shows. One read of the slot index, a
 * primary-key join each. A row whose photo was hidden or deleted has no photo, so the slot shows
 * its built-in one.
 */
export async function readLiveSiteImages(): Promise<SiteImageRow[]> {
  const rows = await getDb()
    .selectDistinctOn([siteImages.slot], rowColumns)
    .from(siteImages)
    .leftJoin(media, shownMedia)
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

type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The text a slot's advisory lock is keyed by (hashtextextended of it): exported for its test. */
export function slotLockName(slot: string): string {
  return `site_images:${slot}`;
}

/**
 * Runs `work` in a short transaction holding the slot's lock, so writes to one slot happen one at a
 * time: each row's saved_at is the clock once the lock is held, so the newest row is the last
 * written, and a "save only if none" decision can't be overtaken by a save in between. Nothing but
 * database statements runs inside.
 */
async function underSlotLock<TResult>(slot: string, work: (transaction: Transaction) => Promise<TResult>): Promise<TResult> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${slotLockName(slot)}, 0))`);
    return work(transaction);
  });
}

/** The saved time of a row written under its slot's lock: the test's own, or the clock now. */
function savedAtOf(now: Date | undefined) {
  return now ?? sql`clock_timestamp()`;
}

/** The slot's live row, read with these queries (a transaction's, or the pool's). */
async function liveRowOf(queries: Database | Transaction, slot: string): Promise<SiteImageRow | null> {
  const [row] = await queries
    .select(rowColumns)
    .from(siteImages)
    .leftJoin(media, eq(media.id, siteImages.mediaId))
    .where(eq(siteImages.slot, slot))
    .orderBy(desc(siteImages.savedAt), desc(siteImages.id))
    .limit(1);
  return row ? toRow(row) : null;
}

/** The slot's live row, or null while it shows its built-in photo unedited. */
export async function readLiveSiteImage(slot: string): Promise<SiteImageRow | null> {
  return liveRowOf(getDb(), slot);
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

/** Inserts a slot's new row, inside its lock: returns the row's id. */
async function insertRow(transaction: Transaction, image: NewSiteImage, now: Date | undefined): Promise<string> {
  const focal = { x: clampFraction(image.focal.x), y: clampFraction(image.focal.y) };
  const live = await liveRowOf(transaction, image.slot);
  const samePicture = live !== null && live.mediaId === image.mediaId && live.focal.x === focal.x && live.focal.y === focal.y;
  const [inserted] = await transaction
    .insert(siteImages)
    .values({
      slot: image.slot,
      mediaId: image.mediaId,
      alt: image.alt.trim(),
      focalX: focal.x,
      focalY: focal.y,
      cardKey: samePicture ? live.cardKey : null,
      savedBy: image.savedBy,
      savedAt: savedAtOf(now),
    })
    .returning({ id: siteImages.id });
  return inserted.id;
}

async function readSaved(id: string): Promise<SiteImageRow> {
  const saved = await readSiteImage(id);
  if (!saved) throw new Error("A saved site image wasn't there to read back");
  return saved;
}

/**
 * Saves a slot: a new row, live at once, under the slot's lock. A save that keeps the live row's
 * photo and focal point (an edit of its alt text) keeps its preview card too, so the card never
 * drops back to the built-in one while the worker would draw the same picture again. `now` defaults
 * to the database's clock once the lock is held; a test passes its own to order saves.
 */
export async function saveSiteImage(image: NewSiteImage, now?: Date): Promise<SiteImageRow> {
  return readSaved(await underSlotLock(image.slot, (transaction) => insertRow(transaction, image, now)));
}

/**
 * Saves the row only if the slot has none at all, deciding under the slot's lock, so a save of the
 * couple's own photo landing at the same moment is never overtaken: whichever comes second is
 * newer. Returns the slot's live row, this one or the one already there (the RSVP card's redraw
 * gives a slot still on its built-in photo a row of its own this way).
 */
export async function saveSiteImageUnlessSaved(image: NewSiteImage): Promise<SiteImageRow> {
  const id = await underSlotLock(image.slot, async (transaction) => {
    const live = await liveRowOf(transaction, image.slot);
    return live ? live.id : insertRow(transaction, image, undefined);
  });
  return readSaved(id);
}

/**
 * Makes an earlier row live again: saved again as the newest, with its photo, alt text, focal point
 * and preview card. Null when there is no such row.
 */
export async function restoreSiteImage(id: string, savedBy: string, now?: Date): Promise<SiteImageRow | null> {
  const earlier = await readSiteImage(id);
  if (!earlier) return null;
  const insertedId = await underSlotLock(earlier.slot, async (transaction) => {
    const [inserted] = await transaction
      .insert(siteImages)
      .values({
        slot: earlier.slot,
        mediaId: earlier.mediaId,
        alt: earlier.alt,
        focalX: earlier.focal.x,
        focalY: earlier.focal.y,
        cardKey: earlier.cardKey,
        savedBy,
        savedAt: savedAtOf(now),
      })
      .returning({ id: siteImages.id });
    return inserted.id;
  });
  return readSiteImage(insertedId);
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

/**
 * The wedding-party members that have a portrait saved in Site photos, by member id, whatever its
 * state: a new member is never given one of these ids, so never shows someone else's portrait.
 */
export async function readPortraitMemberIds(): Promise<string[]> {
  const rows = await getDb()
    .selectDistinct({ slot: siteImages.slot })
    .from(siteImages)
    .where(sql`${siteImages.slot} like 'party-%'`);
  return rows.map((row) => row.slot.slice("party-".length));
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
    .where(and(eq(media.id, mediaId), eq(media.purpose, "site"), isNull(media.hiddenAt), isNull(media.deletedAt)))
    .limit(1);
  return row ?? null;
}
