import type { Celebration } from "@/lib/content/schema";

export type CalendarEvent = {
  uid: string;
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM` in GMT (Ghana has no daylight saving), or null for an all-day event. */
  startTime: string | null;
  endTime: string | null;
  location: string;
  description: string;
};

const DEFAULT_LENGTH_MS = 3 * 60 * 60 * 1000;

export function celebrationEvent(c: Celebration, siteUrl: string): CalendarEvent {
  return {
    uid: `${c.id}@nobletxnancy.com`,
    title: `${c.name} · Noblet & Nancy`,
    date: c.date,
    startTime: c.startTime,
    endTime: c.endTime,
    location: c.place,
    description: `${c.time}\n${siteUrl}`,
  };
}

/** `20261205` or `20261205T100000Z`. */
function stamp(d: Date, dateOnly = false): string {
  const s = d.toISOString().replace(/[-:]/g, "");
  return dateOnly ? s.slice(0, 8) : s.slice(0, 15) + "Z";
}

function utc(date: string, time: string): Date {
  return new Date(`${date}T${time}:00Z`);
}

/** The start and end as calendar values: dates for all-day events, UTC date-times otherwise. */
function span(e: CalendarEvent): { allDay: boolean; start: string; end: string } {
  if (!e.startTime) {
    const start = utc(e.date, "00:00");
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { allDay: true, start: stamp(start, true), end: stamp(end, true) };
  }
  const start = utc(e.date, e.startTime);
  const end = e.endTime ? utc(e.date, e.endTime) : new Date(start.getTime() + DEFAULT_LENGTH_MS);
  return { allDay: false, start: stamp(start), end: stamp(end) };
}

function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a line at 75 octets (not characters), continuing with a leading space. */
function fold(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > limit) {
      out.push(cur);
      cur = " ";
      bytes = 1;
      limit = 75;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out;
}

export function buildIcs(events: CalendarEvent[], now: Date = new Date()): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Noblet & Nancy//Wedding//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-TIMEZONE:Africa/Accra",
  ];
  for (const e of events) {
    const { allDay, start, end } = span(e);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.uid}`,
      `DTSTAMP:${stamp(now)}`,
      allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
      allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
      `SUMMARY:${escapeText(e.title)}`,
      `LOCATION:${escapeText(e.location)}`,
      `DESCRIPTION:${escapeText(e.description)}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.flatMap(fold).join("\r\n") + "\r\n";
}

export function googleCalendarUrl(e: CalendarEvent): string {
  const { start, end } = span(e);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${start}/${end}`,
    location: e.location,
    details: e.description,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
