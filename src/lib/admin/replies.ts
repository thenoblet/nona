import type { EventId } from "@/content/wedding";
import type { Answer, EmailStatus, RsvpRecord } from "@/lib/data/types";
import { emailKey, nameKey, phoneKey } from "@/lib/rsvp/normalize";

// Shared by the replies page, its list in the browser and the CSV export.

export type CelebrationColumn = { id: EventId; name: string };

/** Always shown as words: a colour alone never carries the status. */
export const emailStatusLabels: Record<EmailStatus, string> = {
  sent: "Sent",
  queued: "Sending",
  failed: "Failed",
  none: "No email",
};

// Ghana keeps GMT all year, so a day is always 24 hours there.
const ACCRA = "Africa/Accra";
const DAY_MS = 24 * 60 * 60 * 1000;
const dateAndTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ACCRA,
});
const timeOfDay = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ACCRA });
const isoDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ACCRA });
// A celebration's date is a calendar day with no time, so it is read as UTC.
const shortDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "2026-10-30": the day in Accra. */
export function accraDate(moment: Date): string {
  return isoDay.format(moment);
}

/** "28 Oct, 18:02" in Accra. */
export function accraDateTime(iso: string): string {
  return dateAndTime.format(new Date(iso));
}

/** "Today 09:41", "Yesterday 21:15" or "27 Oct, 18:02", in Accra. */
export function receivedLabel(iso: string, now: Date): string {
  const received = new Date(iso);
  const day = accraDate(received);
  if (day === accraDate(now)) return `Today ${timeOfDay.format(received)}`;
  if (day === accraDate(new Date(now.getTime() - DAY_MS))) return `Yesterday ${timeOfDay.format(received)}`;
  return accraDateTime(iso);
}

/** "Sat 5 Dec" for a celebration's "2026-12-05". */
export function celebrationDay(date: string): string {
  return shortDay.format(new Date(`${date}T00:00:00Z`));
}

export type DuplicateMatch = { name: string; same: "phone" | "email" | "phone and email" };

/**
 * For each current reply, the other current replies under a different name that share its phone
 * or email (compared as the replacement rules compare them). Replies with no match are left out.
 */
export function duplicateMatches(replies: RsvpRecord[]): Map<string, DuplicateMatch[]> {
  const guests = replies.map((reply) => ({
    reply,
    name: nameKey(reply.fullName),
    phone: phoneKey(reply.phone),
    email: reply.email ? emailKey(reply.email) : null,
  }));
  type Guest = (typeof guests)[number];
  const byPhone = new Map<string, Guest[]>();
  const byEmail = new Map<string, Guest[]>();
  for (const guest of guests) {
    if (guest.phone) byPhone.set(guest.phone, [...(byPhone.get(guest.phone) ?? []), guest]);
    if (guest.email) byEmail.set(guest.email, [...(byEmail.get(guest.email) ?? []), guest]);
  }

  const matches = new Map<string, DuplicateMatch[]>();
  for (const guest of guests) {
    const samePhone = byPhone.get(guest.phone) ?? [];
    const sameEmail = guest.email ? (byEmail.get(guest.email) ?? []) : [];
    const found: DuplicateMatch[] = [];
    for (const other of new Set([...samePhone, ...sameEmail])) {
      if (other.name === guest.name) continue;
      const phone = samePhone.includes(other);
      const email = sameEmail.includes(other);
      found.push({ name: other.reply.fullName, same: phone && email ? "phone and email" : phone ? "phone" : "email" });
    }
    if (found.length > 0) matches.set(guest.reply.id, found);
  }
  return matches;
}

/** Possible duplicate of “Kofi Ansa” (same phone) */
export function duplicateNote(match: DuplicateMatch): string {
  return `Possible duplicate of “${match.name}” (same ${match.same})`;
}

export type EarlierReply = { id: string; received: string; details: string[] };

/** What the list in the browser gets for each current reply. */
export type ReplyRow = {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  partySize: string;
  answers: Partial<Record<EventId, Answer>>;
  otherNames?: string;
  song?: string;
  receivedAt: string;
  received: string;
  emailStatus: EmailStatus;
  /** "Possible duplicate of …" notes, empty for most replies. */
  duplicates: string[];
  /** The replies this one replaced, newest first. */
  earlier: EarlierReply[];
};

/** What an earlier reply said, naming the phone, email or spelling only where it differs from now. */
function earlierDetails(earlier: RsvpRecord, current: RsvpRecord, celebrations: CelebrationColumn[]): string[] {
  const details: string[] = [];
  if (earlier.fullName !== current.fullName) details.push(`Name: ${earlier.fullName}`);
  if (earlier.phone !== current.phone) details.push(`Phone: ${earlier.phone}`);
  if ((earlier.email ?? "") !== (current.email ?? "")) details.push(`Email: ${earlier.email ?? "none"}`);
  details.push(earlier.partySize);
  for (const celebration of celebrations) {
    const answer = earlier.answers[celebration.id];
    if (answer) details.push(`${celebration.name} ${answer}`);
  }
  if (earlier.otherNames) details.push(`With: ${earlier.otherNames}`);
  if (earlier.song) details.push(`Song: ${earlier.song}`);
  return details;
}

export function toReplyRows(
  replies: RsvpRecord[],
  histories: Map<string, RsvpRecord[]>,
  celebrations: CelebrationColumn[],
  now: Date,
): ReplyRow[] {
  const matches = duplicateMatches(replies);
  return replies.map((reply) => ({
    id: reply.id,
    fullName: reply.fullName,
    phone: reply.phone,
    email: reply.email,
    partySize: reply.partySize,
    answers: reply.answers,
    otherNames: reply.otherNames,
    song: reply.song,
    receivedAt: reply.receivedAt,
    received: receivedLabel(reply.receivedAt, now),
    emailStatus: reply.emailStatus,
    duplicates: (matches.get(reply.id) ?? []).map(duplicateNote),
    earlier: (histories.get(reply.id) ?? []).map((earlier) => ({
      id: earlier.id,
      received: accraDateTime(earlier.receivedAt),
      details: earlierDetails(earlier, reply, celebrations),
    })),
  }));
}

export const replyFilters = [
  { id: "all", label: "All", attention: false },
  { id: "coming", label: "Coming", attention: false },
  { id: "notComing", label: "Can't come", attention: false },
  { id: "duplicates", label: "Possible duplicates", attention: true },
  { id: "emailFailed", label: "Email failed", attention: true },
] as const;

export type ReplyFilter = (typeof replyFilters)[number]["id"];

/** Coming means yes to at least one celebration; can't come means no to every one answered. */
export function matchesFilter(row: ReplyRow, filter: ReplyFilter): boolean {
  const answers = Object.values(row.answers);
  switch (filter) {
    case "all":
      return true;
    case "coming":
      return answers.includes("yes");
    case "notComing":
      return answers.includes("no") && !answers.includes("yes");
    case "duplicates":
      return row.duplicates.length > 0;
    case "emailFailed":
      return row.emailStatus === "failed";
  }
}

export function countByFilter(rows: ReplyRow[]): Record<ReplyFilter, number> {
  return Object.fromEntries(
    replyFilters.map((filter) => [filter.id, rows.filter((row) => matchesFilter(row, filter.id)).length]),
  ) as Record<ReplyFilter, number>;
}

/** Lower case without accents, reading Ɔ as o and Ɛ as e, so "ofori" finds "Ɔfori". */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replaceAll("ɔ", "o")
    .replaceAll("ɛ", "e")
    .replaceAll("ŋ", "n")
    .replace(/\s+/g, " ")
    .trim();
}

const PHONE_LIKE = /^[\d\s+().-]+$/;

/** Searches the name, the other names, the email and the phone (in any format: "+233 24…" finds "024…"). */
export function matchesSearch(row: ReplyRow, query: string): boolean {
  const wanted = fold(query);
  if (!wanted) return true;
  if (PHONE_LIKE.test(wanted) && /\d/.test(wanted)) {
    const digits = wanted.replace(/\D/g, "");
    const local = digits.length > 3 && digits.startsWith("233") ? `0${digits.slice(3)}` : digits;
    if (row.phone.replace(/\D/g, "").includes(digits) || phoneKey(row.phone).includes(local)) return true;
  }
  return [row.fullName, row.otherNames ?? "", row.email ?? "", row.phone].some((text) => fold(text).includes(wanted));
}

function answerWord(answer: Answer | undefined): string {
  return answer === "yes" ? "Yes" : answer === "no" ? "No" : "";
}

/** The CSV export: a header row, then one row per current reply. Times are in Accra. */
export function replyCsvRows(replies: RsvpRecord[], celebrations: CelebrationColumn[]): string[][] {
  const matches = duplicateMatches(replies);
  const header = [
    "Name",
    "Phone",
    "Email",
    "Party size",
    ...celebrations.map((celebration) => celebration.name),
    "Other names",
    "Song",
    "Received",
    "Email status",
    "Possible duplicate",
  ];
  return [
    header,
    ...replies.map((reply) => {
      const received = new Date(reply.receivedAt);
      return [
        reply.fullName,
        reply.phone,
        reply.email ?? "",
        reply.partySize,
        ...celebrations.map((celebration) => answerWord(reply.answers[celebration.id])),
        reply.otherNames ?? "",
        reply.song ?? "",
        `${accraDate(received)} ${timeOfDay.format(received)}`,
        emailStatusLabels[reply.emailStatus],
        (matches.get(reply.id) ?? []).map((match) => `${match.name} (same ${match.same})`).join("; "),
      ];
    }),
  ];
}
