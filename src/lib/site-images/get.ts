import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { describeError } from "@/lib/log-error";
import { ogSize } from "@/lib/preview-cards/layout";
import { PREVIEW_CARD_ALT } from "@/lib/preview-cards/text";
import { publicUrl } from "@/lib/storage/keys";
import type { Focal } from "./focal";
import { previewSlotId, SITE_IMAGES_TAG, type PreviewCardId } from "./slots";
import { readLiveSiteImages, type SitePhotoFile } from "./store";

/*
 * The site photos as guest pages read them: getSiteImages(), after connection() (the build has no
 * database), cached under SITE_IMAGES_TAG. A save in the admin updates the tag (updateTag), so the
 * next request reads afresh. A preview card the worker draws a few seconds after a save reaches
 * pages when the admin, watching it drawn, updates the tag again. Otherwise (the RSVP card drawn
 * after a settings change, which no one watches) the cache's own lifetime brings it: see cachedRead. src/content/images.ts stays the default: a slot with no live row shows its built-in
 * photo, and so does every slot while the database can't be read.
 */

/** A slot's live row, as plain data the cache can keep. */
export type LiveSlot = {
  id: string;
  /** Null: the slot's built-in photo, with the couple's alt text and focal point. */
  mediaId: string | null;
  alt: string;
  focal: Focal;
  /** The worker-drawn preview card's address on MEDIA_BASE_URL, once drawn. */
  cardUrl: string | null;
  /** The couple's photo, once the worker has made its sizes; null for a built-in, or a photo not ready. */
  photo: (Pick<SitePhotoFile, "derived" | "averageColor"> & { width: number; height: number }) | null;
};

export type SiteImages = Record<string, LiveSlot>;

/** Throws if the database read fails, so a failure is never cached. */
async function cachedRead(): Promise<SiteImages> {
  "use cache";
  cacheTag(SITE_IMAGES_TAG);
  // A card the worker draws with no admin watching (the RSVP card's new words) arrives without a
  // save's updateTag. While pages are being read, a read at least 15 s old is served once more as
  // it is and read again behind it, so the new card shows from the next request on; after a quiet
  // minute the read has expired, and the first request reads afresh. At most one indexed read
  // every 15 s per server process.
  cacheLife({ stale: 15, revalidate: 15, expire: 60 });
  const rows = await readLiveSiteImages();
  const images: SiteImages = {};
  for (const row of rows) {
    const file = row.photo;
    const ready = file?.status === "ready" && file.width !== null && file.height !== null && Object.keys(file.derived).length > 0;
    images[row.slot] = {
      id: row.id,
      mediaId: row.mediaId,
      alt: row.alt,
      focal: row.focal,
      cardUrl: row.cardKey ? publicUrl(row.cardKey) : null,
      photo: ready ? { derived: file.derived, averageColor: file.averageColor, width: file.width!, height: file.height! } : null,
    };
  }
  return images;
}

/** How long the built-in photos stand in after a failed read before the database is tried again. */
const FALLBACK_MILLISECONDS = 30_000;
let fallbackUntil = 0;

/**
 * The live row of every slot that has one. Call it after connection(). If the database can't be
 * read, every slot shows its built-in photo, for 30 s without trying again (so an outage never
 * makes each page wait out the connect timeout), then the next read tries.
 */
export async function getSiteImages(): Promise<SiteImages> {
  if (Date.now() < fallbackUntil) return {};
  try {
    const images = await cachedRead();
    fallbackUntil = 0;
    return images;
  } catch (error) {
    fallbackUntil = Date.now() + FALLBACK_MILLISECONDS;
    console.error("Could not read the site photos; using the built-in ones for 30 s:", describeError(error));
    return {};
  }
}

/** The worker-drawn card for a link preview, when the couple changed its photo and the card is drawn; else null (the build-time card). */
export function storedCardUrl(images: SiteImages, card: PreviewCardId): string | null {
  return images[previewSlotId(card)]?.cardUrl ?? null;
}

/**
 * A page's openGraph `images` pointing at its worker-drawn card, to spread into its openGraph only
 * when there is one: a page that names no images keeps its opengraph-image file's build-time card
 * (Next uses the file only when the page's own metadata leaves `images` out).
 */
export function storedCardImages(images: SiteImages, card: PreviewCardId): { images?: OpenGraphCard[] } {
  const url = storedCardUrl(images, card);
  if (!url) return {};
  return { images: [{ url, width: ogSize.width, height: ogSize.height, alt: PREVIEW_CARD_ALT[card], type: "image/jpeg" }] };
}

type OpenGraphCard = { url: string; width: number; height: number; alt: string; type: string };
