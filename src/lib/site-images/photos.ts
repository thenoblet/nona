import type { StaticImageData } from "next/image";
import nancySmile from "../../../public/images/story/nancy-smile.jpg";
import { homeHeroPhoto, partyPhotos, photos, type Photo } from "@/content/images";
import { previewPhotos, type PreviewCardId } from "@/content/preview-photos";
import { publicUrl } from "@/lib/storage/keys";
import { focalFromPosition, objectPosition, type Focal } from "./focal";
import type { LiveSlot, SiteImages } from "./get";
import { sizeCandidates } from "./sizes";
import { allSlots, partySlotId, type SlotDefinition } from "./slots";

/*
 * What each slot shows a guest: the couple's photo when they replaced it (from the worker's own
 * sizes on MEDIA_BASE_URL, Ruling CI), else its built-in photo from src/content/images.ts (through
 * next/image, as before), with any alt text and focal point they edited. A slot with neither (a
 * wedding-party member with no portrait yet) shows nothing.
 */

/** A built-in photo: the static import (its size and blur placeholder), alt text and object-position. */
export type BuiltinPhoto = { image: StaticImageData; alt: string; position: string };

function builtin(photo: Photo, alt = photo.alt): BuiltinPhoto {
  return { image: photo.src, alt, position: photo.position ?? "center" };
}

const PREVIEW_IMAGES: Record<PreviewCardId, StaticImageData> = {
  invitation: photos.embraceBw.src,
  rsvp: photos.bouquet.src,
  album: photos.kiss.src,
  wishes: nancySmile,
};

const BUILTIN_PHOTOS: Record<string, BuiltinPhoto | null> = {
  "landing-cover": builtin(photos.embraceBw),
  "landing-print": builtin(photos.bouquet),
  // public/images/home/hero.jpg (swap the file to change it), until the couple choose another in Site photos.
  "home-hero": builtin(homeHeroPhoto),
  "invitation-band": builtin(photos.chrysanthemumsWide),
  "story-met-arch": builtin(photos.howWeMetBw),
  "story-met-print": builtin(photos.earlyDays),
  "story-asked-arch": builtin(photos.embraceBw),
  "story-asked-print": builtin(photos.bouquet),
  "story-forever-arch": builtin(photos.daisiesWrapped),
  "story-forever-print": builtin(photos.dressedUp),
  "gallery-left": builtin(photos.bouquet, "Nancy holds her bouquet as they hug"),
  "gallery-centre": builtin(photos.embraceBw, "Noblet and Nancy embrace, in black and white"),
  "gallery-right": builtin(photos.kiss, "Noblet and Nancy share a kiss"),
  ...Object.fromEntries(
    (Object.keys(previewPhotos) as PreviewCardId[]).map((card) => [
      `preview-${card}`,
      { image: PREVIEW_IMAGES[card], alt: previewPhotos[card].alt, position: previewPhotos[card].position },
    ]),
  ),
};

/** The slot's built-in photo, or null for one that has none. */
export function builtinPhoto(slotId: string): BuiltinPhoto | null {
  if (slotId in BUILTIN_PHOTOS) return BUILTIN_PHOTOS[slotId];
  if (slotId.startsWith("party-")) {
    const portrait = partyPhotos[slotId.slice("party-".length)];
    return portrait ? builtin(portrait) : null;
  }
  return null;
}

/** The built-in photo's focal point, from its object-position. */
export function builtinFocal(photo: BuiltinPhoto): Focal {
  return focalFromPosition(photo.position);
}

/** What a slot shows a guest. */
export type SlotPhoto =
  | { kind: "builtin"; image: StaticImageData; alt: string; position: string }
  | {
      kind: "uploaded";
      alt: string;
      position: string;
      /** The photo's own size, for the <img>'s width and height. */
      width: number;
      height: number;
      /** Its sizes on MEDIA_BASE_URL, narrowest first. */
      sources: { url: string; width: number }[];
      averageColor: string | null;
    };

/** What the slot shows: its live row (the couple's photo, or their edit of the built-in one), else the built-in photo. */
export function resolveSlotPhoto(slot: SlotDefinition, live: LiveSlot | undefined, fallback = builtinPhoto(slot.id)): SlotPhoto | null {
  if (live?.mediaId && live.photo) {
    const sources = sizeCandidates(live.photo, slot.maxWidth).map((candidate) => ({
      url: publicUrl(candidate.key),
      width: candidate.width,
    }));
    if (sources.length > 0) {
      return {
        kind: "uploaded",
        alt: live.alt,
        position: objectPosition(live.focal),
        width: live.photo.width,
        height: live.photo.height,
        sources,
        averageColor: live.photo.averageColor,
      };
    }
  }
  if (!fallback) return null;
  if (live && !live.mediaId) return { kind: "builtin", image: fallback.image, alt: live.alt, position: objectPosition(live.focal) };
  return { kind: "builtin", ...fallback };
}

/** Every slot's photo, by slot id: the fixed slots and one per wedding-party member. */
export type SlotPhotos = Record<string, SlotPhoto | null>;

export function slotPhotos(images: SiteImages, party: { id: string; name: string; role: string }[]): SlotPhotos {
  return Object.fromEntries(allSlots(party).map((slot) => [slot.id, resolveSlotPhoto(slot, images[slot.id])]));
}

/** A member's portrait from the slots. */
export function portraitOf(photosBySlot: SlotPhotos, memberId: string): SlotPhoto | null {
  return photosBySlot[partySlotId(memberId)] ?? null;
}
