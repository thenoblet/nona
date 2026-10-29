import { couple, wedding } from "@/content/wedding";
import { previewPhotos } from "@/content/images";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";

/** The invitation card: shown when any page without its own card is shared. */
export const alt = `${couple.groom} & ${couple.bride}, ${wedding.dateLong}, ${wedding.town}, ${wedding.region}`;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.invitation.file);

export default function Image() {
  return previewCard({
    eyebrow: "Together with their families",
    title: [couple.groom, `& ${couple.bride}`],
    line: wedding.dateLong,
    sub: `${wedding.town} · ${wedding.region}`,
    photo,
    position: previewPhotos.invitation.position,
  });
}
