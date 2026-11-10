import { TextLink } from "@/components/ui/Button";
import { celebrationPlace } from "@/lib/content/place";
import type { Celebration, ScheduleItem, SiteContent } from "@/lib/content/schema";
import { formatClock } from "@/lib/content/times";
import { inProgrammeOrder, programmeNow, stateOf, todaysCelebrations } from "./day";

/**
 * The day's timeline, one list per celebration on the day: finished items fade, the current one is
 * marked in orange. Each celebration names its place; an item only names one held elsewhere. The
 * whole weekend is on the Order of the day page.
 */
export function OrderOfDay({
  schedule,
  celebrations,
  venues,
  secondDay,
  now,
}: {
  schedule: ScheduleItem[];
  celebrations: Celebration[];
  venues: SiteContent["venues"];
  secondDay: boolean;
  now: Date;
}) {
  const programme = inProgrammeOrder(schedule);
  const standing = programmeNow(programme, celebrations, now);
  const today = todaysCelebrations(secondDay);
  return (
    <div className="flex flex-col gap-7">
      {celebrations
        .filter((celebration) => today.includes(celebration.id))
        .map((celebration) => (
          <section key={celebration.id} aria-labelledby={`today-${celebration.id}`} className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <h3
                id={`today-${celebration.id}`}
                className="m-0 text-[11px] font-normal uppercase tracking-[0.24em] text-ember-ink"
              >
                {celebration.name}
              </h3>
              <p className="m-0 text-[13px] text-mocha">{celebrationPlace(celebration, venues).place}</p>
            </div>
            <ol className="border-t border-hairline">
              {programme.map((item, index) => {
                if (item.celebration !== celebration.id) return null;
                const state = stateOf(index, standing);
                return (
                  <li
                    key={`${index}-${item.title}`}
                    aria-current={state === "now" ? "step" : undefined}
                    className={`flex items-start gap-3.5 border-b border-hairline py-4 ${state === "done" ? "opacity-55" : ""}`}
                  >
                    <span className="w-17.5 shrink-0 pt-1 text-[11px] uppercase tracking-[0.12em] text-mocha">
                      {item.time ? formatClock(item.time) : null}
                    </span>
                    <span
                      aria-hidden
                      className={`mt-[7px] size-[11px] shrink-0 rounded-full ${
                        state === "now"
                          ? "bg-ember shadow-[0_0_0_5px_var(--color-halo)]"
                          : state === "done"
                            ? "bg-mocha"
                            : "border border-mocha"
                      }`}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className={`font-serif text-[22px] leading-[1.2] ${state === "now" ? "font-semibold" : ""}`}>
                        {item.title}
                        {state === "done" ? <span className="sr-only"> (finished)</span> : null}
                      </span>
                      {item.note ? <span className="text-[13px] text-mocha">{item.note}</span> : null}
                      {item.place ? <span className="text-[13px] text-mocha">{item.place}</span> : null}
                      {state === "now" ? (
                        <span className="mt-[3px] text-[10px] uppercase tracking-[0.24em] text-ember-ink">Happening now</span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      <TextLink href="/programme" className="self-start">
        See the whole order of the day
      </TextLink>
    </div>
  );
}
