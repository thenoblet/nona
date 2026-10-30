import type { Celebration, ScheduleItem } from "@/lib/content/schema";

/** "Saturday · 5 Dec" or "Sunday · 6 Dec". */
export function dayLabel(secondDay: boolean, celebrations: Celebration[]) {
  const celebration = celebrations.find((entry) => entry.id === (secondDay ? "thanks" : "ceremony")) ?? celebrations[0];
  if (!celebration) return "";
  return `${celebration.weekday} · ${Number(celebration.day)} ${celebration.month.slice(0, 3)}`;
}

/**
 * Which schedule item is happening now. Until the timings are confirmed, the second Saturday
 * item stands for all of Saturday and the first Sunday item for Sunday. Always inside the
 * schedule, or -1 when the schedule is empty.
 */
export function nowIndex(schedule: ScheduleItem[], secondDay: boolean): number {
  if (schedule.length === 0) return -1;
  const day = secondDay ? "sun" : "sat";
  if (!secondDay && schedule[1]?.day === "sat") return 1;
  const first = schedule.findIndex((item) => item.day === day);
  return first >= 0 ? first : schedule.length - 1;
}
