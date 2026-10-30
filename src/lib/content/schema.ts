import * as zod from "zod";

/** Text that may run over several lines: answers, story texts, card texts. */
const text = zod.string().trim().min(1, "Cannot be empty");
/** Names, titles, roles, times, places and the like: one line, so a pasted line break can't split a heading. */
const line = text.regex(/^[^\r\n]*$/, "Use one line");
const noSpace = { error: "Remove the space from the link", abort: true } as const;
const link = zod
  .string()
  .regex(/^\S*$/, noSpace)
  .regex(/^(https:\/\/\S+|#\S*)$/, "Use an https:// link or an in-page anchor starting with #");
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const time = zod.string().regex(timePattern, "Use a 24-hour time like 14:30");
const date = zod
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-12-05")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Not a real date");

const celebration = zod
  .object({
    id: zod.enum(["ceremony", "reception", "thanks"]),
    name: line,
    weekday: line,
    weekdayShort: line,
    day: line,
    month: line,
    time: line,
    place: line,
    placeDetail: line.optional(),
    dress: line,
    directionsUrl: link,
    date,
    startTime: time.nullable(),
    endTime: time.nullable(),
  })
  .superRefine((value, context) => {
    // Compared only when both are real times; a malformed one already has its own message.
    const { startTime, endTime } = value;
    if (startTime && endTime && timePattern.test(startTime) && timePattern.test(endTime) && endTime <= startTime) {
      context.addIssue({ code: "custom", path: ["endTime"], message: "Ends must be after Starts" });
    }
  });

const scheduleItem = zod.object({
  time: line,
  title: line,
  place: line,
  day: zod.enum(["sat", "sun"]),
});

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

const giftItem = zod.object({ title: line, text, action: line });

const story = zod.object({
  met: zod.object({ when: line, title: line, text }),
  asked: zod.object({ when: line, title: line, quote: text, answer: line }),
  forever: zod.object({ when: line, title: line, text }),
});

export const sectionSchemas = {
  celebrations: zod
    .array(celebration)
    .length(3, "There must be exactly three celebrations")
    .refine(
      (items) =>
        ["ceremony", "reception", "thanks"].every((id) => items.filter((item) => item.id === id).length === 1),
      "Keep the white wedding, reception and thanksgiving, each once",
    ),
  schedule: zod
    .array(scheduleItem)
    .refine((items) => items.some((item) => item.day === "sat"), "Add at least one Saturday item")
    .refine((items) => items.some((item) => item.day === "sun"), "Add at least one Sunday item"),
  venues: zod.object({ church: venue, reception: venue, hotel: venue }),
  landmarks: zod.array(line),
  faq: zod.array(faqItem),
  travel: zod.array(travelItem),
  gifts: zod.array(giftItem),
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
export type GiftItem = zod.infer<typeof giftItem>;
export type Story = zod.infer<typeof story>;
export type LiveStream = SiteContent["liveStream"];

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
