import type { EventId } from "@/lib/content/schema";

/*
 * What the album sends its page about each moment, and the words it shows for them (Task 15, gate
 * B). Pure and free of server code, so the album's client code shares it with the server, which
 * builds the items (album.ts).
 */

/** The celebration a moment is grouped under; "more" is any other day ("More moments"). */
export type AlbumCelebration = EventId | "more";

export type AlbumKind = "photo" | "video";

/** A video's versions a phone can play, and how its conversion stands. Never its original. */
export type AlbumVideo = {
  /** The H.264 conversion (derived.video), once it is done. */
  converted: string | null;
  /** The clean copy of its own streams (derived.playable): no location, `moov` first. */
  copy: string | null;
  /** The original's video codec as ffprobe named it ("h264", "hevc"…); null before its probe. */
  codec: string | null;
  conversion: "none" | "queued" | "converting" | "done" | "failed";
  /** Why a `failed` conversion failed: "too-long", "too-slow", "corrupt"… */
  conversionFailure: string | null;
};

/** One moment as the album's page has it. */
export type AlbumItem = {
  id: string;
  kind: AlbumKind;
  /** `ready` for everyone; `uploaded` ("Getting it ready") and `failed` only to its own guest. */
  status: "ready" | "uploaded" | "failed";
  /** Uploaded by one of the guests this browser knows. */
  mine: boolean;
  /** The name it was shared under; null for none. */
  by: string | null;
  celebration: AlbumCelebration;
  /** When it was taken (else when it was listed), ISO. */
  takenAt: string | null;
  /** When it became viewable, ISO; null while it isn't. */
  listedAt: string | null;
  width: number | null;
  height: number | null;
  /** The raw ThumbHash in base64, decoded on the phone. */
  thumbhash: string | null;
  /** "#rrggbb", shown before anything else loads. */
  color: string | null;
  /** The thumbnail (a video's poster), about 480 px wide. */
  thumb: string | null;
  /** The viewing size (a video's poster), at most 1600 px on its long edge. */
  view: string | null;
  /** A video's length; null for a photo, or one whose container doesn't say. */
  seconds: number | null;
  video: AlbumVideo | null;
  /** An iPhone photo (HEIC or HEIF), which also downloads as a JPEG. */
  heic: boolean;
  /** The original as the guest shared it: its type in a word ("JPEG", "MOV") and its size. */
  original: { type: string; bytes: number };
  /** Why its processing failed, for its own guest ("corrupt", "too-large"…); null otherwise. */
  failure: string | null;
};

/** A page of the album: its items, newest first, and where the next page starts (null at the end). */
export type AlbumPage = {
  items: AlbumItem[];
  nextCursor: string | null;
  /** The newest listed item's place, which the new-moments check counts from; null for none. */
  newestCursor: string | null;
};

/** The filters the album's three rows set: celebration chips, Photos or Videos, and My uploads. */
export type AlbumFilter = {
  celebration?: AlbumCelebration;
  kind?: AlbumKind;
  mine?: boolean;
};

/** How many moments of each celebration and kind there are, everyone's and the browser's own. */
export type AlbumStats = {
  everyone: AlbumCount[];
  mine: AlbumCount[];
};

export type AlbumCount = { celebration: AlbumCelebration; kind: AlbumKind; count: number };

/** The filter as the album's API reads it: `celebration`, `kind` and `view=mine`. */
export function filterQuery(filter: AlbumFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.celebration) query.set("celebration", filter.celebration);
  if (filter.kind) query.set("kind", filter.kind);
  if (filter.mine) query.set("view", "mine");
  return query;
}

/** The filter a query names, or null when it names one the album doesn't know. */
export function parseFilter(query: URLSearchParams): AlbumFilter | null {
  const celebration = query.get("celebration");
  const kind = query.get("kind");
  const view = query.get("view");
  if (celebration !== null && !(ALBUM_CELEBRATIONS as readonly string[]).includes(celebration)) return null;
  if (kind !== null && kind !== "photo" && kind !== "video") return null;
  if (view !== null && view !== "mine" && view !== "everyone") return null;
  return {
    celebration: (celebration as AlbumCelebration | null) ?? undefined,
    kind: (kind as AlbumKind | null) ?? undefined,
    mine: view === "mine",
  };
}

/** The chips' words, and the viewer's: a celebration in a word or two. */
export const CELEBRATION_LABELS: Record<AlbumCelebration, string> = {
  ceremony: "Ceremony",
  reception: "Reception",
  thanks: "Thanksgiving",
  more: "More moments",
};

/** In a download's filename. */
const CELEBRATION_SLUGS: Record<AlbumCelebration, string> = {
  ceremony: "ceremony",
  reception: "reception",
  thanks: "thanksgiving",
  more: "more",
};

export const ALBUM_CELEBRATIONS: readonly AlbumCelebration[] = ["ceremony", "reception", "thanks", "more"];

/** A download's filename: NONA26-<celebration>-<the id's first eight characters>.<ext>. */
export function downloadFilename(celebration: AlbumCelebration, mediaId: string, extension: string): string {
  return `NONA26-${CELEBRATION_SLUGS[celebration]}-${mediaId.slice(0, 8)}.${extension.toLowerCase()}`;
}

/** How many moments a filter holds: everyone's ready ones, or the browser's own (theirs not ready too). */
export function countFor(stats: AlbumStats, filter: AlbumFilter): number {
  const counts = filter.mine ? stats.mine : stats.everyone;
  return counts
    .filter((count) => (!filter.celebration || count.celebration === filter.celebration) && (!filter.kind || count.kind === filter.kind))
    .reduce((total, count) => total + count.count, 0);
}

/**
 * The counts once these moments are added (`delta` 1: the pill brought them in) or taken away (-1:
 * removed): everyone's for a listed one, the browser's own for one of its own.
 */
export function adjustStats(stats: AlbumStats, items: readonly AlbumItem[], delta: 1 | -1): AlbumStats {
  const change = (counts: AlbumCount[], item: AlbumItem): AlbumCount[] => {
    const known = counts.find((count) => count.celebration === item.celebration && count.kind === item.kind);
    if (!known) return delta > 0 ? [...counts, { celebration: item.celebration, kind: item.kind, count: 1 }] : counts;
    return counts.map((count) => (count === known ? { ...count, count: Math.max(0, count.count + delta) } : count));
  };
  let { everyone, mine } = stats;
  for (const item of items) {
    if (item.status === "ready") everyone = change(everyone, item);
    if (item.mine) mine = change(mine, item);
  }
  return { everyone, mine };
}

/** The celebrations anyone's moments are in: "More moments" shows only when it holds some. */
export function celebrationsWithItems(stats: AlbumStats): Set<AlbumCelebration> {
  return new Set(stats.everyone.filter((count) => count.count > 0).map((count) => count.celebration));
}

/** The count line: "214 moments", "1 photo", "38 videos". */
export function countWords(count: number, kind: AlbumKind | undefined): string {
  const noun = kind === "photo" ? "photo" : kind === "video" ? "video" : "moment";
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/** The pill: "1 new moment", "3 new moments". */
export function newMomentsWords(count: number): string {
  return `${count} new ${count === 1 ? "moment" : "moments"}`;
}

/**
 * A guest's own failed item, in gate A's voice (Noblet's wording, 31 Oct): what went wrong, short.
 * The worker's reasons: `too-large`, `corrupt`, `unsupported-type`, or `processing-failed` once its
 * retries ran out.
 */
export function failureWords(kind: AlbumKind, reason: string | null): string {
  const thing = kind === "video" ? "video" : "photo";
  if (reason === "too-large") return `This ${thing} is too large to show`;
  if (reason === "corrupt" || reason === "unsupported-type") return "We couldn't read this file";
  return `We couldn't get this ${thing} ready`;
}

/** A video whose conversion failed for good, when this phone can't play its copy either. */
export function conversionFailureWords(reason: string | null): string {
  if (reason === "too-long") return "Too long to prepare for your phone. Download the original.";
  return "We couldn't prepare a version for your phone. Download the original.";
}

/** A video's length as the tile shows it: "0:42", "12:05". */
export function clockTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** A size in words, as the menu and the save line say it: "840 KB", "4.2 MB", "1.3 GB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

const ACCRA = "Africa/Accra";
const timeOfDay = new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: ACCRA });
const weekdayDayMonth = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: ACCRA });

/**
 * The viewer's second line: "Reception · 7:42 pm", in Accra's time; a moment from another day
 * ("More moments") says the day instead: "More moments · Fri 4 Dec".
 */
export function detailWords(item: Pick<AlbumItem, "celebration" | "takenAt">): string {
  const label = CELEBRATION_LABELS[item.celebration];
  if (!item.takenAt) return label;
  const moment = new Date(item.takenAt);
  if (Number.isNaN(moment.getTime())) return label;
  if (item.celebration === "more") return `${label} · ${weekdayDayMonth.format(moment).replace(",", "")}`;
  return `${label} · ${timeOfDay.format(moment).replace(/\s/g, " ").toLowerCase()}`;
}

/** "Shared by Ama", "Shared by you", or "Shared by a guest" for none. */
export function sharedByWords(item: Pick<AlbumItem, "mine" | "by">): string {
  if (item.mine) return "Shared by you";
  return item.by ? `Shared by ${item.by}` : "Shared by a guest";
}
