import type { SectionKey } from "@/lib/content/schema";

// Shared by the "Site text" pages, their editor in the browser and the save actions.

/** What a save or restore did. `errors` are the store's messages, e.g. `faq[0].q: Cannot be empty`. */
export type SaveState = { status: "idle" | "saved" | "error"; errors: string[]; version?: number };

/** The editor's form posts the whole edited section as JSON, and the version it loaded. */
export const EDITOR_FIELDS = { value: "value", baseVersion: "baseVersion" } as const;

/** A section's JSON may be at most this long. The largest built-in section is about 2 KB. */
export const MAX_SECTION_BYTES = 256 * 1024;
export const TOO_LONG = "This section is too long to save. Shorten the longest text and try again.";

/** The sections in the admin's order, with their address under /admin/content/ and their name. */
export const contentSections = [
  { key: "celebrations", slug: "celebrations", label: "Celebrations" },
  { key: "schedule", slug: "schedule", label: "Order of the day" },
  { key: "venues", slug: "venues", label: "Venues" },
  { key: "landmarks", slug: "landmarks", label: "Landmarks" },
  { key: "faq", slug: "faq", label: "Questions" },
  { key: "travel", slug: "travel", label: "Travel & stay" },
  { key: "gifts", slug: "gifts", label: "Gifts" },
  { key: "party", slug: "party", label: "Wedding party" },
  { key: "story", slug: "story", label: "Our story" },
  { key: "liveStream", slug: "live-stream", label: "Live stream" },
] as const satisfies readonly { key: SectionKey; slug: string; label: string }[];

export type ContentSection = (typeof contentSections)[number];

export function sectionBySlug(slug: string): ContentSection | undefined {
  return contentSections.find((section) => section.slug === slug);
}

export function sectionByKey(key: SectionKey): ContentSection {
  return contentSections.find((section) => section.key === key)!;
}

export function isSectionKey(key: unknown): key is SectionKey {
  return contentSections.some((section) => section.key === key);
}

const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const months = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * The words the site shows for a celebration's date, or null if it isn't a real date. Spelt out
 * by hand rather than with Intl, so the server and the browser always write the same words.
 */
export function describeDate(
  date: string,
): { weekday: string; weekdayShort: string; day: string; month: string; long: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const moment = new Date(Date.UTC(year, month - 1, day));
  if (moment.getUTCFullYear() !== year || moment.getUTCMonth() !== month - 1 || moment.getUTCDate() !== day) return null;
  const weekday = weekdays[moment.getUTCDay()];
  const monthName = months[month - 1];
  return {
    weekday,
    weekdayShort: weekday.slice(0, 3),
    day: String(day).padStart(2, "0"),
    month: monthName,
    long: `${weekday} ${day} ${monthName} ${year}`,
  };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trims text; empty text becomes `empty` (null or undefined). Anything else is left for the schema. */
function optionalText<TEmpty extends null | undefined>(value: unknown, empty: TEmpty): unknown {
  if (value === undefined || value === null) return empty;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? empty : trimmed;
}

function without(item: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(item).filter(([name]) => name !== key));
}

/** Sets `key` to the trimmed text, or removes it when the text is empty. */
function withOptional(item: JsonObject, key: string): JsonObject {
  const value = optionalText(item[key], undefined);
  return value === undefined ? without(item, key) : { ...item, [key]: value };
}

/** "9:30" and "14.30" (a phone's number pad has no colon) are read as "09:30" and "14:30". */
function optionalTime(value: unknown): unknown {
  const time = optionalText(value, null);
  if (typeof time !== "string") return time;
  const match = /^(\d{1,2})[:.](\d{2})$/.exec(time);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : time;
}

function prepareCelebration(item: unknown): unknown {
  if (!isObject(item)) return item;
  const described = typeof item.date === "string" ? describeDate(item.date) : null;
  const prepared: JsonObject = {
    ...withOptional(item, "placeDetail"),
    startTime: optionalTime(item.startTime),
    endTime: optionalTime(item.endTime),
  };
  if (described) {
    // The day words always follow the date; the couple never type them.
    prepared.weekday = described.weekday;
    prepared.weekdayShort = described.weekdayShort;
    prepared.day = described.day;
    prepared.month = described.month;
  }
  return prepared;
}

/** A typed coordinate as a number, nothing when empty, or the text itself for the schema to refuse. */
function coordinate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return /^[+-]?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function prepareVenue(venue: unknown): unknown {
  if (!isObject(venue)) return venue;
  const prepared = withOptional(venue, "note");
  if (!isObject(venue.coords)) return prepared;
  const lat = coordinate(venue.coords.lat);
  const lng = coordinate(venue.coords.lng);
  // Both empty means no pin on the map; one alone is refused by the schema.
  return lat === undefined && lng === undefined ? without(prepared, "coords") : { ...prepared, coords: { lat, lng } };
}

/** "Ɔkyeame Ɛsi Bóakye" → "okyeame-esi-boakye", the form of a party member's id. */
function slugFrom(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/ɔ/g, "o")
      .replace(/ɛ/g, "e")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "member"
  );
}

/** New members (no id yet) get one from their name, unique in the list; existing ids never change. */
function prepareParty(party: unknown): unknown {
  if (!Array.isArray(party)) return party;
  const taken = new Set(
    party.filter(isObject).flatMap((member) => (typeof member.id === "string" && member.id !== "" ? [member.id] : [])),
  );
  return party.map((member) => {
    if (!isObject(member)) return member;
    // An unticked "lead" box is left out, as in the built-in list.
    const prepared = member.lead === true ? member : without(member, "lead");
    if (typeof member.id === "string" && member.id !== "") return prepared;
    const base = slugFrom(typeof member.name === "string" ? member.name : "");
    let id = base;
    for (let suffix = 2; taken.has(id); suffix++) id = `${base}-${suffix}`;
    taken.add(id);
    return { ...prepared, id };
  });
}

function mapItems(value: unknown, prepare: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(prepare) : value;
}

/**
 * Tidies an edited section before the schema checks it: derives the celebrations' day words from
 * their dates, turns empty optional fields into null or nothing, reads typed coordinates as numbers
 * and gives new party members their ids. Anything not in the expected shape is passed through, so
 * the schema refuses it with a message.
 */
export function prepareSection(key: SectionKey, value: unknown): unknown {
  switch (key) {
    case "celebrations":
      return mapItems(value, prepareCelebration);
    case "venues":
      return isObject(value)
        ? Object.fromEntries(Object.entries(value).map(([name, venue]) => [name, prepareVenue(venue)]))
        : value;
    case "travel":
      return mapItems(value, (item) => (isObject(item) ? withOptional(item, "href") : item));
    case "party":
      return prepareParty(value);
    case "liveStream":
      return isObject(value) ? { ...value, url: optionalText(value.url, null) } : value;
    default:
      return value;
  }
}

/**
 * Reads the store's messages for one section. `path` is the field's place in the section, like
 * "0.startTime" or "hotel.coords.lat", "" for the section as a whole, and null for a message that
 * isn't about a field (such as a newer version having been saved).
 */
export function parseIssues(key: SectionKey, errors: string[]): { path: string | null; message: string }[] {
  const pattern = new RegExp(`^${key}((?:\\[\\d+\\]|\\.[A-Za-z_][\\w]*)*): (.+)$`, "s");
  return errors.map((error) => {
    const match = pattern.exec(error);
    if (!match) return { path: null, message: error };
    const path = match[1].replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "");
    return { path, message: match[2] };
  });
}

const accraTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Africa/Accra" });
const accraDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Accra" });

/** "nancy@example.com saved a newer version at 21:14 on 30 Oct. Reload to see it." ("You" for one's own.) */
export function newerVersionMessage(newer: { savedBy: string; savedAt: Date }, currentAdmin: string): string {
  const who = newer.savedBy === currentAdmin ? "You" : newer.savedBy;
  return `${who} saved a newer version at ${accraTime.format(newer.savedAt)} on ${accraDay.format(newer.savedAt)}. Reload to see it.`;
}
