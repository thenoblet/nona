import { couple, wedding } from "@/content/wedding";
import type { PreviewCardId } from "@/content/preview-photos";
import { accraDayAndFullMonth } from "@/lib/accra";
import type { RsvpSettings } from "@/lib/content/schema";
import type { CardText } from "./layout";

/*
 * What each link preview card says, for the build-time cards (the opengraph-image files) and the
 * media worker's, so the two never differ. Pure: the worker bundles it.
 */

/** Each card's alt text: what og:image:alt says, whichever photo is behind it. */
export const PREVIEW_CARD_ALT: Record<PreviewCardId, string> = {
  invitation: `${couple.groom} & ${couple.bride}, ${wedding.dateLong}, ${wedding.town}, ${wedding.region}`,
  // Fixed when the site is built, so it leaves out the date the couple can change.
  rsvp: `Kindly respond to ${couple.groom} and ${couple.bride}'s wedding`,
  album: `Share your photos and videos in ${couple.groom} and ${couple.bride}'s wedding album`,
  wishes: `Leave ${couple.groom} and ${couple.bride} a wish`,
};

/** The card's words. Only the RSVP card's depend on the site text: its reply-by date, or that replies have closed. */
export function previewCardText(card: PreviewCardId, rsvp: Pick<RsvpSettings, "open" | "replyBy">): CardText {
  switch (card) {
    case "invitation":
      return {
        eyebrow: "Together with their families",
        title: [couple.groom, `& ${couple.bride}`],
        line: wedding.dateLong,
        sub: `${wedding.town} · ${wedding.region}`,
      };
    case "rsvp":
      return {
        eyebrow: "Répondez s'il vous plaît",
        title: ["Kindly respond"],
        line: rsvp.open ? `Please reply by ${accraDayAndFullMonth(rsvp.replyBy)}` : "Replies have closed",
        sub: `${couple.groom} & ${couple.bride} · ${wedding.dateShort}`,
      };
    case "album":
      return {
        eyebrow: `Our shared album · ${couple.hashtag}`,
        title: ["Capture it", "with us"],
        line: "Share your photos & videos",
        sub: "No app · no sign-up",
      };
    case "wishes":
      return {
        eyebrow: "Our guestbook",
        title: ["Leave us a wish"],
        line: "Words, a voice note or a short video",
        sub: `${couple.groom} & ${couple.bride}`,
      };
  }
}
