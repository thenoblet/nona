import { previewPhotos } from "@/content/images";
import { contentDefaults } from "@/lib/content/defaults";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";
import { PREVIEW_CARD_ALT, previewCardText } from "@/lib/preview-cards/text";

/** The wishes' built-in card; once the couple change its photo, the page points og:image at the worker's card. */
export const alt = PREVIEW_CARD_ALT.wishes;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.wishes.file);

export default function Image() {
  return previewCard({
    ...previewCardText("wishes", contentDefaults.rsvp),
    photo,
    position: previewPhotos.wishes.position,
  });
}
