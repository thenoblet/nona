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
 * closed. Each version of the card is drawn once.
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
