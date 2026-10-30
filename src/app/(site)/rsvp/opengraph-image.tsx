import { connection } from "next/server";
import { couple, wedding } from "@/content/wedding";
import { previewPhotos } from "@/content/images";
import { accraDayAndFullMonth } from "@/lib/accra";
import { getSiteContent } from "@/lib/content/get";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";

// The alt text is fixed when the site is built, so it leaves out the date the couple can change.
export const alt = `Kindly respond to ${couple.groom} and ${couple.bride}'s wedding`;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.rsvp.file);

/**
 * Read at request time, so the card shows the reply-by date set in the admin, or that replies have
 * closed. Drawing a card is CPU work that would otherwise belong in the media worker, but it
 * happens in the web server on purpose: the card must change without a deploy, and the build has
 * no database to draw it from. Each wording is drawn once per server process and then served from
 * renderJpeg's cache (see lib/og.tsx), so a crawler's request costs a cache read, not a drawing.
 */
export default async function Image() {
  await connection();
  const { rsvp } = await getSiteContent();
  return previewCard({
    eyebrow: "Répondez s'il vous plaît",
    title: ["Kindly respond"],
    line: rsvp.open ? `Please reply by ${accraDayAndFullMonth(rsvp.replyBy)}` : "Replies have closed",
    sub: `${couple.groom} & ${couple.bride} · ${wedding.dateShort}`,
    photo,
    position: previewPhotos.rsvp.position,
  });
}
