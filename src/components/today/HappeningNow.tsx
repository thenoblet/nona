import { scheduleItemPlace } from "@/lib/content/place";
import type { Celebration, ScheduleItem, SiteContent } from "@/lib/content/schema";
import { currentItem } from "./day";

/** The rounded strip in the header: what's on right now, and where. Nothing while nothing is on. */
export function HappeningNow({
  schedule,
  celebrations,
  venues,
  now,
}: {
  schedule: ScheduleItem[];
  celebrations: Celebration[];
  venues: SiteContent["venues"];
  now: Date;
}) {
  const item = currentItem(schedule, celebrations, now);
  if (!item) return null;
  const place = scheduleItemPlace(item, celebrations, venues).replace(/, Tepa$/, "");
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
