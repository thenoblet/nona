import type { Celebration } from "@/lib/content/schema";
import { endsNextDay } from "@/lib/content/times";

export type CalendarEvent = {
  uid: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM` in GMT (Ghana has no daylight saving), or null for an all-day event. */
  startTime: string | null;
  /** Earlier than `startTime` when the celebration ends after midnight, on the next day. */
  endTime: string | null;
  location: string;
  description: string;
};

const DEFAULT_LENGTH_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const utf8 = new TextEncoder();

export function celebrationEvent(celebration: Celebration, siteUrl: string): CalendarEvent {
  return {
    uid: `${celebration.id}@nobletxnancy.com`,
    title: `${celebration.name} · Noblet & Nancy`,
    date: celebration.date,
    startTime: celebration.startTime,
    endTime: celebration.endTime,
    location: celebration.place,
    description: `${celebration.time}\n${siteUrl}`,
  };
}

/** `20261205` or `20261205T100000Z`. */
function stamp(moment: Date, dateOnly = false): string {
  const compact = moment.toISOString().replace(/[-:]/g, "");
  return dateOnly ? compact.slice(0, 8) : compact.slice(0, 15) + "Z";
}

function utc(date: string, time: string): Date {
  return new Date(`${date}T${time}:00Z`);
}

/** The start and end as calendar values: dates for all-day events, UTC date-times otherwise. */
function span(event: CalendarEvent): { allDay: boolean; start: string; end: string } {
  if (!event.startTime) {
    const start = utc(event.date, "00:00");
    const end = new Date(start.getTime() + DAY_MS);
    return { allDay: true, start: stamp(start, true), end: stamp(end, true) };
  }
  const start = utc(event.date, event.startTime);
  let end = event.endTime ? utc(event.date, event.endTime) : new Date(start.getTime() + DEFAULT_LENGTH_MS);
  if (endsNextDay(event.startTime, event.endTime)) end = new Date(end.getTime() + DAY_MS);
  return { allDay: false, start: stamp(start), end: stamp(end) };
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a line at 75 octets (not characters), continuing with a leading space. */
function fold(line: string): string[] {
  const folded: string[] = [];
  let current = "";
  let bytes = 0;
  for (const character of line) {
    // TextEncoder rather than Buffer: the guest's thank-you page builds calendar links in the browser.
    const size = utf8.encode(character).length;
    if (bytes + size > 75) {
      folded.push(current);
      current = " ";
      bytes = 1;
    }
    current += character;
    bytes += size;
  }
  folded.push(current);
  return folded;
}

/**
 * A calendar file. `stampedAt` is its DTSTAMP: a confirmation email passes the reply's time, so
 * every retry of one email is the same bytes under the same idempotency key.
 */
export function buildIcs(events: CalendarEvent[], stampedAt: Date): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Noblet & Nancy//Wedding//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Africa/Accra",
  ];
  for (const event of events) {
    const { allDay, start, end } = span(event);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTAMP:${stamp(stampedAt)}`,
      allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
      allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
      `SUMMARY:${escapeText(event.title)}`,
      `LOCATION:${escapeText(event.location)}`,
      `DESCRIPTION:${escapeText(event.description)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(event: CalendarEvent): string {
  const { start, end } = span(event);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${start}/${end}`,
    location: event.location,
    details: event.description,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
