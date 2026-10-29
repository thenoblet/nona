import type { StaticImageData } from "next/image";
import type { EventId } from "@/content/wedding";

export type Answer = "yes" | "no";

export type RsvpInput = {
  fullName: string;
  phone: string;
  partySize: string;
  answers: Partial<Record<EventId, Answer>>;
  otherNames?: string;
  meal?: string;
  dietary?: string;
  flight?: string;
  song?: string;
};

export type RsvpRecord = RsvpInput & { id: string; receivedAt: string };

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
