import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { getSiteContent } from "@/lib/content/get";
import type { Celebration, ScheduleItem, SiteContent } from "@/lib/content/schema";
import { isSecondDay } from "@/lib/mode";

type Render = (secondDay: boolean, content: SiteContent) => ReactNode;

async function AtRequest({ render }: { render: Render }) {
  await connection();
  const content = await getSiteContent();
  return render(isSecondDay(new Date()), content);
}

/**
 * Reads the site content once at request time and renders the right day (Sunday moves on to the
 * thanksgiving service). The fallback is a static skeleton, so no content is read in the prerendered shell.
 */
export function ByDay({ fallback, render }: { fallback: ReactNode; render: Render }) {
  return (
    <Suspense fallback={fallback}>
      <AtRequest render={render} />
    </Suspense>
  );
}

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
