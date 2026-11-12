import type { AdminStateName } from "@/lib/db/schema";
import { ALBUM_CELEBRATIONS, askedCelebration, type AlbumCelebration, type AlbumKind, sizeWords } from "./album-item";

/*
 * What the admin's Photos page (Task 17, gate B) has of each album item, its filter, and the words
 * it shows for them. Pure and free of server code, so the page's client code shares it with the
 * server, which builds the items (admin-album.ts).
 */

/** The state chips in gate B's order (Ruling BW), then Highlights, which any item may be as well. */
export const ADMIN_CHIPS = ["failed", "processing", "converting", "queued", "hidden", "removed", "highlights"] as const;
export type AdminChip = (typeof ADMIN_CHIPS)[number];
export type { AdminStateName };

export const CHIP_LABELS: Record<AdminChip, string> = {
  failed: "Failed",
  processing: "Processing",
  converting: "Converting",
  queued: "Queued",
  hidden: "Hidden",
  removed: "Removed",
  highlights: "Highlights",
};

/** The chips that ask for the couple's attention, outlined in the accent (gate B). */
export const ATTENTION_CHIPS: ReadonlySet<AdminChip> = new Set(["failed"]);

/** The longest search of who shared it, in characters: a name is at most 80. */
export const SEARCH_MAX_CHARACTERS = 80;

/** What the album shows: one chip (or all), a celebration, a kind, and part of who shared it. */
export type AdminFilter = {
  chip?: AdminChip;
  celebration?: AlbumCelebration;
  kind?: AlbumKind;
  search?: string;
};

/** Why an item failed: its processing (status `failed`) or a ready video's conversion, with the worker's reason. */
export type AdminFailure = { during: "processing" | "conversion"; reason: string | null };

/** One album item as the admin has it. */
export type AdminItem = {
  id: string;
  kind: AlbumKind;
  /** Its badge and chip; null when it is visible with nothing under way. */
  state: AdminStateName | null;
  /** The name it was shared under; null for none. */
  by: string | null;
  /** How many album items its guest has shared (deleted ones aside); null for no guest. */
  uploads: number | null;
  celebration: AlbumCelebration;
  /** When it finished uploading, ISO: the admin's order. */
  uploadedAt: string;
  /** When it was taken, ISO, if known. */
  takenAt: string | null;
  hiddenAt: string | null;
  /** "guest" when its uploader removed it, else the admin who hid it (their sign-in email). */
  hiddenBy: string | null;
  highlight: boolean;
  width: number | null;
  height: number | null;
  /** A video's length in seconds. */
  seconds: number | null;
  /** The raw ThumbHash in base64, decoded on the page: all a hidden item shows (Ruling BV). */
  thumbhash: string | null;
  color: string | null;
  /** The thumbnail (a video's poster); never for a hidden or removed item, whose public files are deleted. */
  thumb: string | null;
  /** The viewing size (a video's poster); never for a hidden or removed item. */
  view: string | null;
  failure: AdminFailure | null;
  /** The original as the guest shared it: its type in a word, its size, and whether it is an iPhone's HEIC. */
  original: { type: string; bytes: number; heic: boolean };
  /** When the original's 30-day lock lets it be deleted permanently, ISO. */
  deletableFrom: string;
  /** Whether that time had come when the server read it (the delete re-checks). */
  deletable: boolean;
};

/** A page of the admin's album and where the next one starts (null at the end). */
export type AdminPage = { items: AdminItem[]; nextCursor: string | null };

/** One celebration and kind's counts, as the counts query groups them. */
export type AdminCountRow = { celebration: AlbumCelebration; kind: AlbumKind; total: number } & Record<AdminChip, number>;

/** The counts the page shows: everything, and each chip's. */
export type AdminCounts = { total: number; chips: Record<AdminChip, number> };

function noChips(): Record<AdminChip, number> {
  return Object.fromEntries(ADMIN_CHIPS.map((chip) => [chip, 0])) as Record<AdminChip, number>;
}

/** The counts for the celebration and kind shown, summed from the grouped rows. */
export function countsFor(rows: readonly AdminCountRow[], filter: Pick<AdminFilter, "celebration" | "kind">): AdminCounts {
  const counts: AdminCounts = { total: 0, chips: noChips() };
  for (const row of rows) {
    if (filter.celebration && row.celebration !== filter.celebration) continue;
    if (filter.kind && row.kind !== filter.kind) continue;
    counts.total += row.total;
    for (const chip of ADMIN_CHIPS) counts.chips[chip] += row[chip];
  }
  return counts;
}

/** The query values the page's address keeps the filter in. */
const QUERY = { chip: "show", celebration: "celebration", kind: "kind", search: "q" } as const;

type QueryLike = Pick<URLSearchParams, "get">;

/** The filter a query names (an empty search is none), or null when it names one the admin doesn't offer. */
export function parseAdminFilter(query: QueryLike): AdminFilter | null {
  const chip = query.get(QUERY.chip);
  const celebration = askedCelebration(query.get(QUERY.celebration));
  const kind = query.get(QUERY.kind);
  const search = query.get(QUERY.search)?.trim() ?? "";
  if (chip !== null && !(ADMIN_CHIPS as readonly string[]).includes(chip)) return null;
  if (celebration !== null && !(ALBUM_CELEBRATIONS as readonly string[]).includes(celebration)) return null;
  if (kind !== null && kind !== "photo" && kind !== "video") return null;
  if ([...search].length > SEARCH_MAX_CHARACTERS) return null;
  const filter: AdminFilter = {};
  if (chip !== null) filter.chip = chip as AdminChip;
  if (celebration !== null) filter.celebration = celebration as AlbumCelebration;
  if (kind !== null) filter.kind = kind;
  if (search) filter.search = search;
  return filter;
}

/** The filter as the page's address and the next-page route read it. */
export function adminFilterQuery(filter: AdminFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.chip) query.set(QUERY.chip, filter.chip);
  if (filter.celebration) query.set(QUERY.celebration, filter.celebration);
  if (filter.kind) query.set(QUERY.kind, filter.kind);
  if (filter.search) query.set(QUERY.search, filter.search);
  return query;
}

/** A page's search params (Next's record) as a query. */
export function queryOf(searchParams: Record<string, string | string[] | undefined>): URLSearchParams {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(searchParams)) {
    if (typeof value === "string") query.set(name, value);
    else if (Array.isArray(value) && value.length > 0) query.set(name, value[0]);
  }
  return query;
}

export type BadgeTone = "ok" | "wait" | "bad" | "none";
/** A badge: its colour, the panel's words, and the tile's (shorter where they must be). */
export type Badge = { tone: BadgeTone; panel: string; tile: string };

/** The item's badge (gate B), or null for one with nothing to say. */
export function badgeOf(item: Pick<AdminItem, "state">): Badge | null {
  switch (item.state) {
    case "removed":
      return { tone: "none", panel: "Removed by guest", tile: "Removed" };
    case "hidden":
      return { tone: "none", panel: "Hidden", tile: "Hidden" };
    case "failed":
      return { tone: "bad", panel: "Failed", tile: "Failed" };
    case "processing":
      return { tone: "wait", panel: "Processing", tile: "Processing" };
    case "converting":
      return { tone: "wait", panel: "Converting", tile: "Converting" };
    case "queued":
      return { tone: "wait", panel: "Waiting to convert", tile: "Queued" };
    default:
      return null;
  }
}

const ACCRA = "Africa/Accra";
const dayMonthTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ACCRA,
});
const weekdayDayMonthTime = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ACCRA,
});

const weekdayTime = new Intl.DateTimeFormat("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ACCRA });

/** "Sat 19:47", in Accra's time: short enough for a tile, and the wedding weekend's days tell apart. */
export function tileTimeWords(iso: string): string {
  return weekdayTime.format(new Date(iso)).replace(",", "");
}

/** "5 Dec, 19:47", in Accra's time, as the panel and badges say a moment. */
export function shortTimeWords(iso: string): string {
  return dayMonthTime.format(new Date(iso));
}

/** "Sat 5 Dec, 19:47", in Accra's time, for the panel's facts. */
export function longTimeWords(iso: string): string {
  return weekdayDayMonthTime.format(new Date(iso)).replace(/^(\w{3}),/, "$1");
}

/** When the item may be deleted permanently: "4 Jan, 20:30". */
export function lockWords(deletableFrom: string): string {
  return shortTimeWords(deletableFrom);
}

/** What guests see of the item now, after its badge in the panel (gate B). */
export function statusWords(item: Pick<AdminItem, "kind" | "state" | "by" | "hiddenAt" | "hiddenBy" | "failure">): string {
  switch (item.state) {
    case "removed":
      return `${item.by ?? "Its guest"} removed it${item.hiddenAt ? ` at ${shortTimeWords(item.hiddenAt)}` : ""}. Guests can't see it.`;
    case "hidden":
      return `Hidden${item.hiddenBy ? ` by ${item.hiddenBy}` : ""}${item.hiddenAt ? `, ${shortTimeWords(item.hiddenAt)}` : ""}. Guests can't see it.`;
    case "failed":
      return item.failure?.during === "conversion"
        ? "Guests can see its poster, but phones that can't play the original have no version to play."
        : "Guests can't see it until it's processed.";
    case "processing":
      return "Making the thumbnail and viewing size. Guests see it in a moment.";
    case "converting":
      return "Guests can see it. A version for phones is being made.";
    case "queued":
      return "Guests can see it. A version for phones waits in the backlog.";
    default:
      return "Guests can see it.";
  }
}

/** A worker's failure reason in plain words (gate B shows the worker's own word under it). */
export function failureReasonWords(failure: AdminFailure, kind: AlbumKind): string {
  const thing = kind === "video" ? "video" : "photo";
  switch (failure.reason) {
    case "corrupt":
      return "The file is damaged or cut short, so it couldn't be read.";
    case "unsupported-type":
      return `This ${thing}'s format can't be read.`;
    case "too-large":
      return "The file is larger than the album takes.";
    case "too-long":
      return failure.during === "conversion" ? "The video is too long to convert for phones." : "The video is longer than the album takes.";
    case "too-slow":
      return "Converting it for phones took too long, three times in a row.";
    default:
      return failure.during === "conversion" ? "Converting it for phones failed after several tries." : "Processing it failed after several tries.";
  }
}

/** The original in a line: "HEIC · 2.0 MB · 3024 × 4032". */
export function fileWords(item: Pick<AdminItem, "original" | "width" | "height">): string {
  const parts = [item.original.type, sizeWords(item.original.bytes)];
  if (item.width && item.height) parts.push(`${item.width} × ${item.height}`);
  return parts.join(" · ");
}

/** "1 upload", "9 uploads". */
export function uploadsWords(count: number): string {
  return `${count} ${count === 1 ? "upload" : "uploads"}`;
}

/** One wish as the admin's Wishes tab has it. */
export type AdminWish = {
  id: string;
  kind: "text" | "voice" | "video";
  /** A written wish's words; null for a recording. */
  message: string | null;
  signedAs: string;
  createdAt: string;
  hiddenAt: string | null;
  hiddenBy: string | null;
  /**
   * A voice or video wish's recording (a media row of purpose `wish`): where Task 16 plays it. Null
   * for a written wish.
   */
  recording: {
    mediaId: string;
    kind: "audio" | "video" | "photo";
    status: "uploading" | "uploaded" | "ready" | "failed";
    seconds: number | null;
    /** The file the wall plays, once ready and while visible: what the couple play here. Null otherwise. */
    url: string | null;
    /** A video message's poster, with its file. */
    poster: string | null;
  } | null;
  /** When a recording's 30-day lock lets the wish be deleted, ISO; null for a written wish, which has none. */
  deletableFrom: string | null;
  /** Whether it may be deleted now, as the server read it (the delete re-checks). */
  deletable: boolean;
};

/** A page of the admin's wishes and where the next one starts (null at the end). */
export type AdminWishPage = { wishes: AdminWish[]; nextCursor: string | null };

/** The wish's status, as the Wishes tab badges it. */
export function wishBadgeOf(wish: Pick<AdminWish, "hiddenAt" | "recording">): Badge {
  if (wish.hiddenAt) return { tone: "none", panel: "Hidden", tile: "Hidden" };
  if (wish.recording?.status === "failed") return { tone: "bad", panel: "Failed", tile: "Failed" };
  if (wish.recording && wish.recording.status !== "ready") return { tone: "wait", panel: "Getting it ready", tile: "Getting it ready" };
  return { tone: "ok", panel: "Showing", tile: "Showing" };
}
