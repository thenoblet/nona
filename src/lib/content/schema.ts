import * as zod from "zod";
import { celebrations as builtInCelebrations, venues as builtInVenues, wedding } from "@/content/wedding";
import { TIME_PATTERN } from "./times";

/** The celebrations are fixed: their wording is editable, but exactly these three exist. */
export const EVENT_IDS = ["ceremony", "reception", "thanks"] as const;
export type EventId = (typeof EVENT_IDS)[number];
/** Each celebration's name in the admin, where the order of the day is grouped by it. */
export const EVENT_LABELS: Record<EventId, string> = { ceremony: "White wedding", reception: "Reception", thanks: "Thanksgiving" };

/** The venues, each typed once under Site text → Venues. */
export const VENUE_KEYS = ["church", "reception", "hotel"] as const;
export type VenueKey = (typeof VENUE_KEYS)[number];
/** Each venue's name in the admin: its heading under Venues, and the choice wherever a venue is picked. */
export const VENUE_LABELS: Record<VenueKey, string> = { church: "Church", reception: "Reception", hotel: "Hotel" };

/** The venues a celebration can be held at. The hotel is only where guests stay. */
export const CELEBRATION_VENUES = ["church", "reception"] as const satisfies readonly VenueKey[];
export type CelebrationVenue = (typeof CELEBRATION_VENUES)[number];

/** Text that may run over several lines: answers, story texts, card texts. */
const text = zod.string().trim().min(1, "Cannot be empty");
/** Names, titles, roles, times, places and the like: one line, so a pasted line break can't split a heading. */
const line = text.regex(/^[^\r\n]*$/, "Use one line");
const noSpace = { error: "Remove the space from the link", abort: true } as const;
const link = zod
  .string()
  .regex(/^\S*$/, noSpace)
  .regex(/^(https:\/\/\S+|#\S*)$/, "Use an https:// link or an in-page anchor starting with #");
const time = zod.string().regex(TIME_PATTERN, "Use a 24-hour time like 14:30");
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const date = zod
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-05")
  .refine(isRealDate, "Not a real date");

/** A place detail that only gives the GhanaPost GPS, from before the GPS came from the venue. */
const GPS_ONLY_DETAIL = /^\s*GhanaPost GPS\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keeps celebrations saved before each named its venue (every version saved before 31 Oct 2026)
 * readable: one without a venue is held where the built-in text holds it, and its place detail is
 * dropped if it only gave the GhanaPost GPS, as the GPS now comes from the venue. An old place and
 * directions link are left out, like any key the schema doesn't know. A celebration that names its
 * venue is read as it is, so a GPS typed into its note is refused rather than lost.
 */
function withVenue(value: unknown): unknown {
  if (!isRecord(value) || value.venue !== undefined) return value;
  const builtIn = builtInCelebrations.find((entry) => entry.id === value.id);
  const read: Record<string, unknown> = { ...value, venue: builtIn?.venue };
  if (typeof value.placeDetail === "string" && GPS_ONLY_DETAIL.test(value.placeDetail)) delete read.placeDetail;
  return read;
}

const celebration = zod.preprocess(
  withVenue,
  zod
    .object({
      id: zod.enum(EVENT_IDS),
      /** Where it is held: its place, GhanaPost GPS and directions all come from this venue. */
      venue: zod.enum(CELEBRATION_VENUES, { error: "Choose the church or the reception venue" }),
      name: line,
      weekday: line,
      weekdayShort: line,
      day: line,
      month: line,
      time: line,
      /** An extra note shown under the venue's GPS, such as "Main hall, upstairs". */
      placeDetail: line.optional(),
      dress: line,
      date,
      startTime: time.nullable(),
      endTime: time.nullable(),
    })
    .superRefine((value, context) => {
      // An end before the start is after midnight (see endsNextDay); only the same time is refused.
      // Compared only when both are real times; a malformed one already has its own message.
      const { startTime, endTime } = value;
      if (startTime && endTime && TIME_PATTERN.test(startTime) && TIME_PATTERN.test(endTime) && endTime === startTime) {
        context.addIssue({ code: "custom", path: ["endTime"], message: "Ends must be after Starts" });
      }
      // The GPS is typed once, on the venue, so the site never shows two numbers for one place.
      if (value.placeDetail !== undefined && GPS_ONLY_DETAIL.test(value.placeDetail)) {
        const message = `Put the GPS number in Venues → ${VENUE_LABELS[value.venue]} → GhanaPost GPS`;
        context.addIssue({ code: "custom", path: ["placeDetail"], message });
      }
    }),
);

/** The venue a place names, "BN 111 Katakyie St" or "BN 111 Katakyie St, Tepa", in the built-in text. */
function venueNamed(place: unknown): VenueKey | undefined {
  if (typeof place !== "string") return undefined;
  const typed = place.trim();
  return VENUE_KEYS.find((key) => {
    const name = builtInVenues[key].name;
    return typed === name || typed === `${name}, ${wedding.town}`;
  });
}

function isVenueKey(value: unknown): value is VenueKey {
  return VENUE_KEYS.some((key) => key === value);
}

/** "14:30", "9.30", "2:30 PM", "2 pm" as a 24-hour time, or undefined for anything else. */
export function readClock(typed: string): string | undefined {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s*m\.?)?$/i.exec(typed.trim());
  if (!match) return undefined;
  const [, hourText, minutes = "00", meridiem] = match;
  let hour = Number(hourText);
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    hour = (hour % 12) + (meridiem.toLowerCase() === "p" ? 12 : 0);
  } else if (match[2] === undefined) {
    // A bare number like "10" is not clearly a time.
    return undefined;
  }
  const clock = `${String(hour).padStart(2, "0")}:${minutes}`;
  return TIME_PATTERN.test(clock) ? clock : undefined;
}

/** Old times that only named the day, like "Sun 6 Dec": the celebration's heading now gives the date. */
const DAY_ONLY_TIME = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s+\d/i;

/**
 * Keeps schedules saved before items belonged to a celebration (every version saved before
 * 11 Nov 2026) readable. Those items named a day, a venue or a typed place, and a free-text time:
 * - Sunday items go to the thanksgiving; Saturday items to the white wedding until the first item
 *   at the reception venue, and to the reception from there on.
 * - An item at its celebration's own venue now takes the place from it; one at another venue keeps
 *   that venue's name as its typed place.
 * - A time is read as a clock time when it is one ("2:30 PM"); a placeholder like "[Time]" or a
 *   day like "Sun 6 Dec" is dropped, and any other words move into the note.
 */
function withCelebrations(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  let reachedReception = false;
  return value.map((entry: unknown) => {
    if (!isRecord(entry) || entry.celebration !== undefined) return entry;
    const { day, venue: savedVenue, time: savedTime, ...rest } = entry;
    const venue = savedVenue ?? venueNamed(entry.place);
    if (day === "sat" && venue === "reception") reachedReception = true;
    const celebration: EventId = day === "sun" ? "thanks" : reachedReception ? "reception" : "ceremony";
    const item: Record<string, unknown> = { ...rest, celebration };
    if (isVenueKey(venue)) {
      const celebrationVenue = builtInCelebrations.find((built) => built.id === celebration)?.venue;
      if (venue === celebrationVenue) delete item.place;
      else item.place = `${builtInVenues[venue].name}, ${wedding.town}`;
    }
    if (typeof savedTime === "string") {
      const clock = readClock(savedTime);
      const words = savedTime.trim();
      if (clock) item.time = clock;
      else if (words !== "" && !/\[.*\]/.test(words) && !DAY_ONLY_TIME.test(words) && item.note === undefined) {
        item.note = words;
      }
    }
    return item;
  });
}

const scheduleItem = zod.object({
  /** The celebration it is part of: its day, and its place unless one is typed. */
  celebration: zod.enum(EVENT_IDS, { error: "Choose a celebration" }),
  /** When it starts, if it has a set time; guests see "2:30 PM". */
  time: time.optional(),
  title: line,
  /** A line under the title, such as "Please be seated early". */
  note: line.optional(),
  /** Only for an item away from its celebration's venue, as guests should read it. */
  place: line.optional(),
});

/**
 * Each celebration keeps at least one item. The white wedding's and the thanksgiving's times run
 * in order; the reception's may go past midnight, so an earlier time there is read as the next day.
 */
function checkSchedule(
  items: readonly unknown[],
  context: { addIssue: (issue: { code: "custom"; message: string; path?: (string | number)[] }) => void },
) {
  // An item that failed its own checks may arrive here as it was sent.
  const records = items.map((item) => (isRecord(item) ? item : {}));
  for (const id of EVENT_IDS) {
    if (!records.some((item) => item.celebration === id)) {
      context.addIssue({ code: "custom", message: `Add at least one ${EVENT_LABELS[id]} item` });
    }
  }
  const previous = new Map<unknown, { time: string; title: string }>();
  records.forEach((item, index) => {
    if (typeof item.time !== "string" || !TIME_PATTERN.test(item.time)) return;
    const before = previous.get(item.celebration);
    if (item.celebration !== "reception" && before && item.time < before.time) {
      const message = `Earlier than ${before.title || "the item before"}: times run in order`;
      context.addIssue({ code: "custom", path: [index, "time"], message });
    }
    previous.set(item.celebration, { time: item.time, title: typeof item.title === "string" ? item.title : "" });
  });
}

const coordinate = (limit: number, example: string) =>
  zod
    .number({ error: `Use a number like ${example}` })
    .min(-limit, `Use a number from -${limit} to ${limit}`)
    .max(limit, `Use a number from -${limit} to ${limit}`);

const venue = zod.object({
  name: line,
  address: line,
  gps: line,
  coords: zod.object({ lat: coordinate(90, "7.019267"), lng: coordinate(180, "-2.145361") }).optional(),
  mapsUrl: link,
  note: line.optional(),
});

const faqItem = zod.object({
  question: line,
  answer: text,
  topic: zod.literal("live-stream").optional(),
});

const partyMember = zod.object({
  id: zod.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use a lower-case slug like maid-of-honour"),
  name: line,
  role: line,
  lead: zod.boolean().optional(),
});

const travelItem = zod.object({
  icon: zod.enum(["bed", "pin", "heart"]),
  title: line,
  text,
  link: line,
  href: link.optional(),
});


const story = zod.object({
  met: zod.object({ when: line, title: line, text }),
  asked: zod.object({ when: line, title: line, quote: text, answer: line }),
  forever: zod.object({ when: line, title: line, text }),
});

/** The first day of the wedding weekend, "2026-12-05". */
const weddingDay = wedding.weekendStart.slice(0, 10);

const rsvp = zod.object({
  open: zod.boolean(),
  // Days written YYYY-MM-DD sort as text. A date that isn't real already has its own message.
  replyBy: date.refine((value) => !isRealDate(value) || value < weddingDay, "Use a date before the wedding"),
  closedMessage: text.max(300, "Use at most 300 characters"),
});

export const sectionSchemas = {
  celebrations: zod
    .array(celebration)
    .length(3, "There must be exactly three celebrations")
    .refine(
      (items) =>
        EVENT_IDS.every((id) => items.filter((item) => item.id === id).length === 1),
      "Keep the white wedding, reception and thanksgiving, each once",
    ),
  schedule: zod.preprocess(withCelebrations, zod.array(scheduleItem).superRefine(checkSchedule)),
  venues: zod.object({ church: venue, reception: venue, hotel: venue } satisfies Record<VenueKey, typeof venue>),
  landmarks: zod.array(line),
  faq: zod.array(faqItem),
  travel: zod.array(travelItem),
  // Photos are found by id, so two people sharing one would share a portrait.
  party: zod.array(partyMember).superRefine((members, context) => {
    const seen = new Set<string>();
    members.forEach((member: unknown, index) => {
      // A member that failed its own checks may arrive here as it was sent.
      const id = typeof member === "object" && member !== null ? (member as { id?: unknown }).id : undefined;
      if (typeof id !== "string") return;
      if (seen.has(id)) {
        context.addIssue({ code: "custom", path: [index, "id"], message: "Each person needs a different id" });
      }
      seen.add(id);
    });
  }),
  story,
  liveStream: zod.object({
    url: zod
      .string()
      .regex(/^\S*$/, noSpace)
      .pipe(zod.url({ protocol: /^https$/, error: "Use an https:// link, or leave it empty" }))
      .nullable(),
  }),
  // Edited on the Replies page (/admin/rsvps), not among the site text.
  rsvp,
} as const;

export type SectionKey = keyof typeof sectionSchemas;
export const sectionKeys = Object.keys(sectionSchemas) as SectionKey[];

export type SiteContent = { [TKey in SectionKey]: zod.infer<(typeof sectionSchemas)[TKey]> };

export type Celebration = zod.infer<typeof celebration>;
export type ScheduleItem = zod.infer<typeof scheduleItem>;
export type Venue = zod.infer<typeof venue>;
export type FaqItem = zod.infer<typeof faqItem>;
export type PartyMember = zod.infer<typeof partyMember>;
export type TravelItem = zod.infer<typeof travelItem>;
export type Story = zod.infer<typeof story>;
export type LiveStream = SiteContent["liveStream"];
export type RsvpSettings = SiteContent["rsvp"];

/** Human-readable messages that name the field, e.g. `celebrations[0].startTime: Use a 24-hour time like 14:30`. */
export function formatIssues(error: zod.ZodError, root = ""): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.reduce<string>(
      (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)),
      root,
    );
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
