import { EVENT_IDS, type Celebration, type EventId } from "@/lib/content/schema";
import { endsNextDay, TIME_PATTERN } from "@/lib/content/times";

/*
 * Which celebration an upload belongs to, from when it was taken. The upload API and the media
 * worker both call this, so it is pure (no I/O) and imports nothing from next/ and no images
 * (celebration.test.ts checks).
 *
 * Times are Accra's, which is UTC all year with no daylight saving, so all of this is UTC
 * arithmetic and never the machine's own time zone.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long a celebration with a start but no end lasts. */
const DEFAULT_LENGTH_MS = 3 * HOUR_MS;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The window a celebration has while its start time isn't set; any end on its own is ignored. */
const DEFAULT_WINDOWS: Record<EventId, { startTime: string; endTime: string }> = {
  ceremony: { startTime: "10:00", endTime: "13:00" },
  reception: { startTime: "14:00", endTime: "23:59" },
  thanks: { startTime: "09:00", endTime: "12:00" },
};

/** A celebration's window as UTC milliseconds: it holds its start, and its end belongs to what follows. */
type Window = { id: EventId; date: string; start: number; end: number };

/** Milliseconds since the epoch for a "YYYY-MM-DD" date and "HH:MM" time in Accra, or null if either is malformed. */
function accraTime(date: string, time: string): number | null {
  const dateParts = DATE_PATTERN.exec(date);
  if (!dateParts || !TIME_PATTERN.test(time)) return null;
  const [hours, minutes] = time.split(":").map(Number);
  return Date.UTC(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3]), hours, minutes);
}

function windowOf(celebration: Celebration): Window | null {
  const times = celebration.startTime
    ? { startTime: celebration.startTime, endTime: celebration.endTime }
    : DEFAULT_WINDOWS[celebration.id];
  const start = accraTime(celebration.date, times.startTime);
  if (start === null) return null;
  const end = times.endTime ? accraTime(celebration.date, times.endTime) : null;
  if (end === null) return { id: celebration.id, date: celebration.date, start, end: start + DEFAULT_LENGTH_MS };
  // An end before the start is after midnight, on the next day (the same rule as the calendar files).
  const overnight = endsNextDay(times.startTime, times.endTime) ? DAY_MS : 0;
  return { id: celebration.id, date: celebration.date, start, end: end + overnight };
}

function contains(window: Window, moment: number): boolean {
  return window.start <= moment && moment < window.end;
}

/** How far a moment lies outside a window. */
function distance(window: Window, moment: number): number {
  return moment < window.start ? window.start - moment : moment - window.end;
}

function isReadable(date: Date | null): date is Date {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

/**
 * The celebration an upload is grouped under, or "more" (More moments). The rules, in order:
 * 1. Inside a celebration's window → that celebration. Where windows overlap, the one that
 *    started last.
 * 2. On the ceremony and reception's day (Saturday), outside both windows → the one whose window
 *    is nearest.
 * 3. On the thanksgiving's day (Sunday) → the thanksgiving, unless rule 1 matched (a reception
 *    running past midnight keeps its early-Sunday photos).
 * 4. Any other day → "more".
 * 5. With no readable capture time, the upload time stands in for it.
 *
 * Rules 2 and 3 are one rule: outside every window, a day that has celebrations goes to its
 * nearest one. The days come from the celebrations' own dates, so moving them in the admin moves
 * the weekend. A tie goes to the first in the order white wedding, reception, thanksgiving.
 */
export function assignCelebration(capturedAt: Date | null, uploadedAt: Date, celebrations: Celebration[]): EventId | "more" {
  const takenAt = isReadable(capturedAt) ? capturedAt : uploadedAt;
  if (!isReadable(takenAt)) return "more";
  const moment = takenAt.getTime();
  const windows = celebrations
    .map(windowOf)
    .filter((window) => window !== null)
    .sort((first, second) => EVENT_IDS.indexOf(first.id) - EVENT_IDS.indexOf(second.id));

  let inside: Window | null = null;
  for (const window of windows) {
    if (contains(window, moment) && (!inside || window.start > inside.start)) inside = window;
  }
  if (inside) return inside.id;

  const day = takenAt.toISOString().slice(0, 10);
  let nearest: Window | null = null;
  for (const window of windows) {
    if (window.date !== day) continue;
    if (!nearest || distance(window, moment) < distance(nearest, moment)) nearest = window;
  }
  return nearest ? nearest.id : "more";
}
