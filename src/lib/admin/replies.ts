import type { EventId } from "@/content/wedding";
import { accraDate, accraDateTime, accraTime } from "@/lib/accra";
import type { Answer, EmailStatus, RsvpFlag, RsvpRecord } from "@/lib/data/types";
import { phoneKey, phoneSearchKeys } from "@/lib/rsvp/normalize";

// Shared by the replies page, its list in the browser and the CSV export.

export type CelebrationColumn = { id: EventId; name: string };

/** Always shown as words: a colour alone never carries the status. */
const emailStatusLabels: Record<EmailStatus, string> = {
  sent: "Sent",
  queued: "Sending",
  failed: "Failed",
  none: "No email",
};

/**
 * The confirmation's status in words. A reply with an email but nothing queued says "Not sent":
 * the daily cap held it back, its job could not be queued, or the server restarted first. The
 * job queue tries those from the last day again when it starts.
 */
export function emailStatusLabel(reply: { email?: string; emailStatus: EmailStatus }): string {
  if (reply.emailStatus === "none" && reply.email) return "Not sent";
  return emailStatusLabels[reply.emailStatus];
}

// Ghana keeps GMT all year, so a day is always 24 hours there.
const DAY_MS = 24 * 60 * 60 * 1000;
// A celebration's date is a calendar day with no time, so it is read as UTC.
const shortDay = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/** "Today 09:41", "Yesterday 21:15" or "27 Oct, 18:02", in Accra. */
export function receivedLabel(iso: string, now: Date): string {
  const received = new Date(iso);
  const day = accraDate(received);
  if (day === accraDate(now)) return `Today ${accraTime(received)}`;
  if (day === accraDate(new Date(now.getTime() - DAY_MS))) return `Yesterday ${accraTime(received)}`;
  return accraDateTime(iso);
}

/** "Sat 5 Dec" for a celebration's "2026-12-05". */
export function celebrationDay(date: string): string {
  return shortDay.format(new Date(`${date}T00:00:00Z`));
}

/**
 * "Replied again: also replied as Ama Owusu on 28 Oct, 18:02 (same phone)" or
 * "Possible duplicate of Kofi Ansa on 28 Oct, 18:02 (same email)". The date is the other reply's,
 * in Accra, so two replies under one name read differently.
 */
export function flagNote(flag: RsvpFlag, otherReceivedAt?: string): string {
  const when = otherReceivedAt ? ` on ${accraDateTime(otherReceivedAt)}` : "";
  return flag.kind === "possible-duplicate"
    ? `Possible duplicate of ${flag.otherName}${when} (same ${flag.via})`
    : `Replied again: also replied as ${flag.otherName}${when} (same ${flag.via})`;
}

/** The CSV's shorter wording: "Replied again: Ama Owusu (same phone)". */
function flagWords(flag: RsvpFlag): string {
  return flag.kind === "replied-again"
    ? `Replied again: ${flag.otherName} (same ${flag.via})`
    : `Possible duplicate of ${flag.otherName} (same ${flag.via})`;
}

/** A flag as the list shows it, with the other reply's id and time ("28 Oct, 18:02") for "Keep both". */
export type ReplyFlag = {
  kind: RsvpFlag["kind"];
  otherId: string;
  otherName: string;
  otherReceived: string;
  note: string;
};

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
  /** The other current replies to check this one against, empty for most replies. */
  flags: ReplyFlag[];
  /** The replies moved into this one's history, newest first. */
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
  const receivedAt = new Map(replies.map((reply) => [reply.id, reply.receivedAt]));
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
    flags: reply.flags.map((flag) => {
      const otherReceivedAt = receivedAt.get(flag.otherId);
      return {
        kind: flag.kind,
        otherId: flag.otherId,
        otherName: flag.otherName,
        otherReceived: otherReceivedAt ? accraDateTime(otherReceivedAt) : "",
        note: flagNote(flag, otherReceivedAt),
      };
    }),
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
  { id: "toCheck", label: "To check", attention: true },
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
    case "toCheck":
      return row.flags.length > 0;
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

/**
 * Searches the name, the other names, the email and the phone. Both numbers are read through
 * phoneKey, so any way of writing either finds the other ("+233 (0)24…" and "00233 24…" find
 * "024…"), and the first or middle digits are enough ("0240" finds "024 000 0000").
 */
export function matchesSearch(row: ReplyRow, query: string): boolean {
  const wanted = fold(query);
  if (!wanted) return true;
  if (PHONE_LIKE.test(wanted)) {
    const stored = phoneKey(row.phone);
    if (phoneSearchKeys(wanted).some((key) => stored.includes(key))) return true;
  }
  return [row.fullName, row.otherNames ?? "", row.email ?? "", row.phone].some((text) => fold(text).includes(wanted));
}

function answerWord(answer: Answer | undefined): string {
  return answer === "yes" ? "Yes" : answer === "no" ? "No" : "";
}

/** The CSV export: a header row, then one row per current reply. Times are in Accra. */
export function replyCsvRows(replies: RsvpRecord[], celebrations: CelebrationColumn[]): string[][] {
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
    "Flags",
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
        `${accraDate(received)} ${accraTime(received)}`,
        emailStatusLabel(reply),
        reply.flags.map(flagWords).join("; "),
      ];
    }),
  ];
}
