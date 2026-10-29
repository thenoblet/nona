import { couple } from "@/content/wedding";
import { previewPhotos } from "@/content/images";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";

export const alt = `Leave ${couple.groom} and ${couple.bride} a wish`;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.wishes.file);

export default function Image() {
  return previewCard({
    eyebrow: "Our guestbook",
    title: ["Leave us a wish"],
    line: "Words, a voice note or a short video",
    sub: `${couple.groom} & ${couple.bride}`,
    photo,
    position: previewPhotos.wishes.position,
  });
}
