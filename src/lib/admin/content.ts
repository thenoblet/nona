import { accraDayAndMonth, accraTime } from "@/lib/accra";
import type { SectionKey } from "@/lib/content/schema";

// Shared by the "Site text" pages, their editor in the browser and the save actions.

/** What a save or restore did. `errors` are the store's messages, e.g. `faq[0].question: Cannot be empty`. */
export type SaveState = { status: "idle" | "saved" | "error"; errors: string[]; version?: number };

/** The editor's form posts the whole edited section as JSON, and the version it loaded. */
export const EDITOR_FIELDS = { value: "value", baseVersion: "baseVersion" } as const;

/** An action was sent something the page it came from would never send: an old page, or not a page. */
export const RELOAD = "This page is out of date. Reload it and try again.";

/** A version the page can have shown: a whole number from 0, the built-in text being version 0. */
export function isVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A section's JSON may be at most this long. The largest built-in section is about 2 KB. */
export const MAX_SECTION_BYTES = 256 * 1024;
export const TOO_LONG = "This section is too long to save. Shorten the longest text and try again.";

/**
 * The sections in the admin's order, with their address under /admin/content/ and their name. The
 * RSVP settings are not among them: they live on the Replies page (/admin/rsvps).
 */
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
export type ContentSectionKey = ContentSection["key"];

export function sectionBySlug(slug: string): ContentSection | undefined {
  return contentSections.find((section) => section.slug === slug);
}

export function isSectionKey(key: unknown): key is ContentSectionKey {
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

/** "nancy@example.com saved a newer version at 21:14 on 30 Oct. Reload to see it." ("You" for one's own.) */
export function newerVersionMessage(newer: { savedBy: string; savedAt: Date }, currentAdmin: string): string {
  const who = newer.savedBy === currentAdmin ? "You" : newer.savedBy;
  return `${who} saved a newer version at ${accraTime(newer.savedAt)} on ${accraDayAndMonth(newer.savedAt)}. Reload to see it.`;
}
