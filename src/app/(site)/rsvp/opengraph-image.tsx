import { previewPhotos } from "@/content/images";
import { contentDefaults } from "@/lib/content/defaults";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";
import { PREVIEW_CARD_ALT, previewCardText } from "@/lib/preview-cards/text";

// The alt text leaves out the date the couple can change.
export const alt = PREVIEW_CARD_ALT.rsvp;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.rsvp.file);

/**
 * The RSVP card as built, with the built-in reply-by date. Drawn once at build time, like the other
 * three: the web server never draws a card (Ruling CJ). Once the couple change the RSVP settings (the
 * date, or closing replies) or the card's photo, the media worker draws the card with the words as
 * they are (lib/site-images/cards.ts), and the page's og:image points at that one instead.
 */
export default function Image() {
  return previewCard({
    ...previewCardText("rsvp", contentDefaults.rsvp),
    photo,
    position: previewPhotos.rsvp.position,
  });
}
