import { couple } from "@/content/wedding";
import { previewPhotos } from "@/content/images";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";

export const alt = `Share your photos and videos in ${couple.groom} and ${couple.bride}'s wedding album`;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.album.file);

export default function Image() {
  return previewCard({
    eyebrow: `Our shared album · ${couple.hashtag}`,
    title: ["Capture it", "with us"],
    line: "Share your photos & videos",
    sub: "No app · no sign-up",
    photo,
    position: previewPhotos.album.position,
  });
}
