import { z } from "zod";

const text = z.string().trim().min(1, "Cannot be empty");
const link = z
  .string()
  .regex(/^(https:\/\/\S+|#\S*)$/, "Use an https:// link or an in-page anchor starting with #");
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 14:30");
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-05")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Not a real date");

const celebration = z.object({
  id: z.enum(["ceremony", "reception", "thanks"]),
  name: text,
  weekday: text,
  weekdayShort: text,
  day: text,
  month: text,
  time: text,
  place: text,
  placeDetail: text.optional(),
  dress: text,
  directionsUrl: link,
  date,
  startTime: time.nullable(),
  endTime: time.nullable(),
});

const scheduleItem = z.object({
  time: text,
  title: text,
  place: text,
  day: z.enum(["sat", "sun"]),
});

const venue = z.object({
  name: text,
  address: text,
  gps: text,
  coords: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  mapsUrl: link,
  note: text.optional(),
});

const faqItem = z.object({
  q: text,
  a: text,
  topic: z.literal("live-stream").optional(),
});

const partyMember = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use a lower-case slug like maid-of-honour"),
  name: text,
  role: text,
  lead: z.boolean().optional(),
});

const travelItem = z.object({
  icon: z.enum(["bed", "pin", "heart"]),
  title: text,
  text,
  link: text,
  href: link.optional(),
});

const giftItem = z.object({ title: text, text, action: text });

const story = z.object({
  met: z.object({ when: text, title: text, text }),
  asked: z.object({ when: text, title: text, quote: text, answer: text }),
  forever: z.object({ when: text, title: text, text }),
});

export const sectionSchemas = {
  celebrations: z
    .array(celebration)
    .length(3, "There must be exactly three celebrations")
    .refine(
      (items) => ["ceremony", "reception", "thanks"].every((id) => items.filter((c) => c.id === id).length === 1),
      "Keep the white wedding, reception and thanksgiving, each once",
    ),
  schedule: z
    .array(scheduleItem)
    .refine((items) => items.some((i) => i.day === "sat"), "Add at least one Saturday item")
    .refine((items) => items.some((i) => i.day === "sun"), "Add at least one Sunday item"),
  venues: z.object({ church: venue, reception: venue, hotel: venue }),
  landmarks: z.array(text),
  faq: z.array(faqItem),
  travel: z.array(travelItem),
  gifts: z.array(giftItem),
  party: z.array(partyMember),
  story,
  liveStream: z.object({ url: z.url({ protocol: /^https$/ }).nullable() }),
} as const;

export type SectionKey = keyof typeof sectionSchemas;
export const sectionKeys = Object.keys(sectionSchemas) as SectionKey[];

export type SiteContent = { [K in SectionKey]: z.infer<(typeof sectionSchemas)[K]> };

export type Celebration = z.infer<typeof celebration>;
export type ScheduleItem = z.infer<typeof scheduleItem>;
export type Venue = z.infer<typeof venue>;
export type FaqItem = z.infer<typeof faqItem>;
export type PartyMember = z.infer<typeof partyMember>;
export type TravelItem = z.infer<typeof travelItem>;
export type GiftItem = z.infer<typeof giftItem>;
export type Story = z.infer<typeof story>;
export type LiveStream = SiteContent["liveStream"];

/** Human-readable messages that name the field, e.g. `celebrations[0].startTime: Use a 24-hour time like 14:30`. */
export function formatIssues(error: z.ZodError, root = ""): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.reduce<string>(
      (acc, part) => (typeof part === "number" ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)),
      root,
    );
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
