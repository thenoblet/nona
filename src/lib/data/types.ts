import type { StaticImageData } from "next/image";
import type { EventId } from "@/content/wedding";
import type {
  CONVERSION_STATES,
  MEDIA_FILE_KINDS,
  MEDIA_PURPOSES,
  MEDIA_STATUSES,
  UPLOAD_EVENT_KINDS,
  WISH_KINDS,
} from "@/lib/db/schema";

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
  /**
   * The reply's own guest, whose personal link its confirmation carries (Ruling CB); missing for a
   * reply sent before personal links.
   */
  guestId?: string;
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

export type WishKind = (typeof WISH_KINDS)[number];

export type Wish = {
  id: string;
  kind: WishKind;
  message?: string;
  /** Voice or video length, e.g. "0:24". */
  duration?: string;
  signedAs: string;
  createdAt: string;
};

export type WishInput = {
  kind: WishKind;
  message?: string;
  signedAs: string;
  /** The sending guest, once guests are recognised. */
  guestId?: string;
  /** A voice or video wish's recording. */
  mediaId?: string;
};

/** A browser that has RSVPed or uploaded (guests.ts). */
export type Guest = {
  id: string;
  /** The name they typed, or null when they gave none. */
  displayName: string | null;
  /** The secret in their personal link, /my/<linkToken>. */
  linkToken: string;
  createdAt: string;
};

/** What an upload is for: the album, a voice or video wish, or one of the site's own photos. */
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
/** What an uploaded file is. Voice wishes are audio. */
export type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];
/** uploading → uploaded (verified, waiting for the worker) → ready, or failed. */
export type MediaStatus = (typeof MEDIA_STATUSES)[number];
/** A video's conversion to a version every phone can play. */
export type ConversionState = (typeof CONVERSION_STATES)[number];
/** The celebration an item is grouped under; "more" is any other day. */
export type MediaCelebration = EventId | "more";
/** What a phone reported while uploading. */
export type UploadEventKind = (typeof UPLOAD_EVENT_KINDS)[number];
