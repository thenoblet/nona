import { couple, wedding } from "@/content/wedding";
import { previewPhotos } from "@/content/images";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";

export const alt = `Kindly respond to ${couple.groom} and ${couple.bride}'s wedding by ${wedding.rsvpBy}`;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.rsvp.file);

export default function Image() {
  return previewCard({
    eyebrow: "Répondez s'il vous plaît",
    title: ["Kindly respond"],
    line: `Please reply by ${wedding.rsvpBy}`,
    sub: `${couple.groom} & ${couple.bride} · ${wedding.dateShort}`,
    photo,
    position: previewPhotos.rsvp.position,
  });
}
