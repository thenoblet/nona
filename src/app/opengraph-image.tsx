import { previewPhotos } from "@/content/images";
import { loadPhoto, ogContentType, ogSize, previewCard } from "@/lib/og";
import { PREVIEW_CARD_ALT, previewCardText } from "@/lib/preview-cards/text";
import { contentDefaults } from "@/lib/content/defaults";

/**
 * The invitation card: shown when any page without its own card is shared. Once the couple change
 * its photo in the admin, the root layout's metadata points og:image at the worker's card instead.
 */
export const alt = PREVIEW_CARD_ALT.invitation;
export const size = ogSize;
export const contentType = ogContentType;

const photo = await loadPhoto(previewPhotos.invitation.file);

export default function Image() {
  return previewCard({
    ...previewCardText("invitation", contentDefaults.rsvp),
    photo,
    position: previewPhotos.invitation.position,
  });
}
