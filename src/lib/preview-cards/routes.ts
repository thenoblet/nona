import type { PreviewCardId } from "@/content/preview-photos";

/**
 * Where each build-time card is served: its opengraph-image file's route. Next names a card in a
 * route group with a short hash of its folder ("(site)/album" → "-1yd5v2"); routes.test.ts checks
 * these against Next's own naming, so a moved file can't leave the admin showing a missing card.
 */
export const BUILT_IN_CARD_PATHS: Record<PreviewCardId, string> = {
  invitation: "/opengraph-image",
  rsvp: "/rsvp/opengraph-image-14vx45",
  album: "/album/opengraph-image-1yd5v2",
  wishes: "/wishes/opengraph-image-1r9m11",
};
