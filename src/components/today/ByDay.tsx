import { Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { celebrations, schedule } from "@/content/wedding";
import { isSecondDay } from "@/lib/mode";

type Render = (secondDay: boolean) => ReactNode;

async function AtRequest({ render }: { render: Render }) {
  await connection();
  return render(isSecondDay(new Date()));
}

/**
 * Renders Saturday's version in the static shell, then swaps in the right day
 * at request time (Sunday moves on to the thanksgiving service).
 */
export function ByDay({ render }: { render: Render }) {
  return (
    <Suspense fallback={render(false)}>
      <AtRequest render={render} />
    </Suspense>
  );
}

/** "Saturday · 5 Dec" or "Sunday · 6 Dec". */
export function dayLabel(secondDay: boolean) {
  const c = celebrations.find((e) => e.id === (secondDay ? "thanks" : "ceremony")) ?? celebrations[0];
  return `${c.weekday} · ${Number(c.day)} ${c.month.slice(0, 3)}`;
}

/**
 * Which schedule item is happening now. Until the timings are confirmed,
 * the white wedding stands for all of Saturday and the thanksgiving for Sunday.
 */
export function nowIndex(secondDay: boolean) {
  return secondDay ? schedule.findIndex((s) => s.day === "sun") : 1;
}
