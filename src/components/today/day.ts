import { EVENT_IDS, type Celebration, type EventId, type ScheduleItem } from "@/lib/content/schema";
import { endsNextDay } from "@/lib/content/times";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
/** The longest an item shows as happening now when nothing after it has a time. */
const LONGEST_ITEM = 4 * 60 * MINUTE;

/** "Saturday · 5 Dec" or "Sunday · 6 Dec". */
export function dayLabel(secondDay: boolean, celebrations: Celebration[]) {
  const celebration = celebrations.find((entry) => entry.id === (secondDay ? "thanks" : "ceremony")) ?? celebrations[0];
  if (!celebration) return "";
  return `${celebration.weekday} · ${Number(celebration.day)} ${celebration.month.slice(0, 3)}`;
}

/** The celebrations on the day: the white wedding and reception on Saturday, the thanksgiving on Sunday. */
export function todaysCelebrations(secondDay: boolean): readonly EventId[] {
  return secondDay ? ["thanks"] : ["ceremony", "reception"];
}

/** The programme in celebration order, each celebration's items in the order the couple set. */
export function inProgrammeOrder<TItem extends Pick<ScheduleItem, "celebration">>(schedule: readonly TItem[]): TItem[] {
  return EVENT_IDS.flatMap((id) => schedule.filter((item) => item.celebration === id));
}

/** A celebration's date at a 24-hour time, in Ghana (GMT all year, so UTC). */
function at(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00Z`);
}

/**
 * When each item starts, or null for one without a time. A reception time earlier than the one
 * before it is after midnight, on the next day; so is every time after it.
 */
export function itemStarts(schedule: readonly ScheduleItem[], celebrations: readonly Celebration[]): (number | null)[] {
  const previous = new Map<EventId, string>();
  const pastMidnight = new Set<EventId>();
  return schedule.map((item) => {
    const celebration = celebrations.find((entry) => entry.id === item.celebration);
    if (!item.time || !celebration) return null;
    const before = previous.get(item.celebration);
    if (item.celebration === "reception" && before !== undefined && item.time < before) pastMidnight.add(item.celebration);
    previous.set(item.celebration, item.time);
    return at(celebration.date, item.time) + (pastMidnight.has(item.celebration) ? DAY : 0);
  });
}

/** When a celebration ends, if its end time is set. */
function celebrationEnd(celebration: Celebration | undefined): number | null {
  if (!celebration?.endTime) return null;
  const end = at(celebration.date, celebration.endTime);
  return endsNextDay(celebration.startTime, celebration.endTime) ? end + DAY : end;
}

export type ProgrammeState = "done" | "now" | "next";

/** Where the programme stands: the item on now (-1 for none) and the last one that has started. */
export type ProgrammeNow = { current: number; started: number };

/**
 * Which item of `schedule` (in programme order) is happening now, by the clock. The current item is
 * the last one with a time that has started; it stays current until the next timed item starts,
 * its celebration ends (when an end time is set) or four hours have passed, whichever is first.
 * Items without a time are never current: they read as done or still to come by where they sit.
 */
export function programmeNow(
  schedule: readonly ScheduleItem[],
  celebrations: readonly Celebration[],
  now: Date,
): ProgrammeNow {
  const starts = itemStarts(schedule, celebrations);
  const time = now.getTime();
  let started = -1;
  starts.forEach((start, index) => {
    if (start !== null && start <= time) started = index;
  });
  if (started < 0) return { current: -1, started };
  const start = starts[started]!;
  const nextStart = starts.slice(started + 1).find((later): later is number => later !== null && later > start);
  const ends = [
    start + LONGEST_ITEM,
    nextStart ?? Infinity,
    celebrationEnd(celebrations.find((entry) => entry.id === schedule[started].celebration)) ?? Infinity,
  ];
  return { current: time < Math.min(...ends) ? started : -1, started };
}

/** How an item reads against where the programme stands. */
export function stateOf(index: number, standing: ProgrammeNow): ProgrammeState {
  if (index === standing.current) return "now";
  return index <= standing.started ? "done" : "next";
}

/** Nothing has started: what the programme shows outside the wedding weekend. */
export const notStarted: ProgrammeNow = { current: -1, started: -1 };

/** The item on right now, by the clock, or undefined while nothing is. */
export function currentItem(
  schedule: readonly ScheduleItem[],
  celebrations: readonly Celebration[],
  now: Date,
): ScheduleItem | undefined {
  const programme = inProgrammeOrder(schedule);
  return programme[programmeNow(programme, celebrations, now).current];
}
