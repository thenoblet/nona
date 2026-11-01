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

/** How far a recorded wish's recording has got: being made ready by the worker, ready, or failed. */
export type WishMediaState = "processing" | "ready" | "failed";

/** What the wall plays of a ready recording: public files the worker made, never the guest's original. */
export type WishRecording = {
  /** A voice note's M4A, or a video message's MP4. */
  url: string;
  /** A video message's poster; null for a voice note. */
  poster: string | null;
  /** A video message's picture, upright; null for a voice note. */
  width: number | null;
  height: number | null;
};

export type Wish = {
  id: string;
  kind: WishKind;
  message?: string;
  /** Voice or video length, e.g. "0:24". */
  duration?: string;
  signedAs: string;
  createdAt: string;
  /** A voice or video wish's files, once its recording is ready. */
  recording?: WishRecording;
  /**
   * A voice or video wish whose recording is still being made ready, or failed: only its sender's
   * browser is ever shown one (Ruling BR).
   */
  pending?: { mediaId: string; state: Exclude<WishMediaState, "ready"> };
};

/** A written wish to save. */
export type TextWishInput = {
  kind: "text";
  message?: string;
  signedAs: string;
  /** The sending browser's own guest, when it has one. */
  guestId?: string;
};

/** A voice or video wish to save, naming its recording. */
export type RecordedWishInput = {
  kind: "voice" | "video";
  /** The recording: the media id the upload API gave the guest's phone. */
  mediaId: string;
  signedAs: string;
  /** Every guest the sending browser knows (its cookie's): the recording must be one of theirs. */
  guestIds: readonly string[];
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
