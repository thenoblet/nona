import { connection } from "next/server";
import { previewPhotos } from "@/content/images";
import { getSiteContent } from "@/lib/content/get";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";
import { PREVIEW_CARD_ALT, previewCardText } from "@/lib/preview-cards/text";

// The alt text is fixed when the site is built, so it leaves out the date the couple can change.
export const alt = PREVIEW_CARD_ALT.rsvp;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.rsvp.file);

/**
 * The RSVP card with its built-in photo, read at request time, so the card shows the reply-by date
 * set in the admin, or that replies have closed. Drawing a card is CPU work that would otherwise
 * belong in the media worker, but this one happens in the web server on purpose (from before the
 * worker drew cards): the card must change without a deploy, and the build has no database to draw
 * it from. Each wording is drawn once per server process and then served from renderJpeg's cache
 * (see lib/og.tsx), so a crawler's request costs a cache read, not a drawing. Once the couple
 * change the card's photo in the admin, the page points og:image at the worker's card instead, and
 * the worker draws it again whenever the reply-by date or the replies' state changes.
 */
export default async function Image() {
  await connection();
  const { rsvp } = await getSiteContent();
  return previewCard({
    ...previewCardText("rsvp", rsvp),
    photo,
    position: previewPhotos.rsvp.position,
  });
}
