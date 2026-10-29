import { schedule } from "@/content/wedding";
import { nowIndex } from "./ByDay";

/** The day's timeline: finished items fade, the current one is marked in orange. */
export function OrderOfDay({ secondDay }: { secondDay: boolean }) {
  const now = nowIndex(secondDay);
  return (
    <ol className="border-t border-hairline">
      {schedule.map((s, i) => {
        const state = i < now ? "done" : i === now ? "now" : "next";
        return (
          <li
            key={s.title}
            aria-current={state === "now" ? "step" : undefined}
            className={`flex items-start gap-3.5 border-b border-hairline py-4 ${state === "done" ? "opacity-55" : ""}`}
          >
            <span className="w-17.5 shrink-0 pt-1 text-[11px] uppercase tracking-[0.12em] text-mocha">{s.time}</span>
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
                {s.title}
                {state === "done" ? <span className="sr-only"> (finished)</span> : null}
              </span>
              <span className="text-[13px] text-mocha">{s.place}</span>
              {state === "now" ? (
                <span className="mt-[3px] text-[10px] uppercase tracking-[0.24em] text-ember-ink">Happening now</span>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
