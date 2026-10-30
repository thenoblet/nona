import type { StaticImageData } from "next/image";
import type { EventId } from "@/content/wedding";

export type Answer = "yes" | "no";

export type RsvpInput = {
  fullName: string;
  phone: string;
  email?: string;
  partySize: string;
  answers: Partial<Record<EventId, Answer>>;
  otherNames?: string;
  song?: string;
};

export type EmailStatus = "none" | "queued" | "sent" | "failed";

/**
 * Another current reply sharing this one's phone or email: "replied-again" when the names match
 * too, "possible-duplicate" when they don't (families answer for each other).
 */
export type RsvpFlag = {
  kind: "replied-again" | "possible-duplicate";
  otherId: string;
  otherName: string;
  /** The phone when both match. */
  via: "phone" | "email";
};

export type RsvpRecord = RsvpInput & {
  id: string;
  receivedAt: string;
  /** Set when the couple kept another reply over this one; null for a current reply. */
  supersededAt: string | null;
  emailStatus: EmailStatus;
  /** The current replies to check against this one, newest first. Only listRsvps() fills it. */
  flags: RsvpFlag[];
};

export type MediaKind = "photo" | "video";

export type MediaItem = {
  id: string;
  kind: MediaKind;
  /** A CloudFront URL later; a bundled image while the album is stubbed. */
  src: string | StaticImageData | null;
  alt: string;
  position?: string;
  event: EventId;
  /** Video length, e.g. "0:42". */
  duration?: string;
  uploaderName: string;
  uploaderDevice: string;
  uploadedAt: string;
};

export type MediaFilter = {
  event?: EventId | "all";
  /** Only this phone's uploads ("My uploads"). */
  device?: string;
};

export type WishKind = "text" | "voice" | "video";

export type Wish = {
  id: string;
  kind: WishKind;
  message?: string;
  /** Voice or video length, e.g. "0:24". */
  duration?: string;
  signedAs: string;
  createdAt: string;
};

export type WishInput = { kind: WishKind; message?: string; signedAs: string };
