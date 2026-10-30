import type { ScheduleItem } from "@/lib/content/schema";
import { nowIndex } from "./ByDay";

/** The rounded strip in the header: what's on right now, and where. */
export function HappeningNow({ schedule, secondDay }: { schedule: ScheduleItem[]; secondDay: boolean }) {
  const item = schedule[nowIndex(schedule, secondDay)];
  if (!item) return null;
  const place = item.place.replace(/, Tepa$/, "");
  return (
    <div className="flex items-center gap-3.5 rounded-full border border-ember/50 px-5 py-3">
      <span className="live-dot" aria-hidden />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-[0.26em] text-ember">Happening now</span>
        <span className="font-serif text-[19px] leading-snug">
          {item.title} · {place}
        </span>
      </div>
    </div>
  );
}
