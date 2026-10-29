"use client";

import type { Celebration } from "@/lib/content/schema";
import type { Answer } from "@/lib/data/types";
import { Icon } from "@/components/ui/Icon";
import { answerField } from "./options";

/** `on` colours the chosen pill; `mark` colours its filled radio circle. */
const choices: { value: Answer; label: string; on: string; mark: string }[] = [
  { value: "yes", label: "Joyfully accept", on: "border-ember bg-ember text-cocoa", mark: "border-cocoa bg-cocoa text-white" },
  { value: "no", label: "Regretfully decline", on: "border-mocha bg-mocha text-white", mark: "border-white bg-white text-mocha" },
];

const settle = "ease-[cubic-bezier(0.16,1,0.3,1)]";

/** The part before the first separator: "[Start time] · please be seated early" becomes "[Start time]". */
const lead = (s: string, sep: string) => s.split(sep)[0].trim();

/** The place without its town: "BN 111 Katakyie St, Tepa" becomes "BN 111 Katakyie St". */
const withoutTown = (s: string) => (s.includes(",") ? s.slice(0, s.lastIndexOf(",")).trim() : s);

/** "[Start time] · Assemblies of God, Victory Worship Centre": a short time and place for the card. */
export function whenLine(c: Celebration) {
  return `${lead(c.time, " · ")} · ${withoutTown(c.place)}`;
}

/**
 * One white card per celebration, with accept and decline as two radio pills.
 * Each pill shows an empty circle until chosen, so it reads as tappable from the start.
 */
export function CelebrationChoice({
  celebration: c,
  value,
  onChange,
}: {
  celebration: Celebration;
  value: Answer | undefined;
  onChange: (value: Answer) => void;
}) {
  const accepted = value === "yes";
  return (
    <div
      className={`flex flex-col gap-4 rounded-[var(--radius-paper)] bg-white px-4 pt-5 pb-4 shadow-[var(--shadow-paper)] outline -outline-offset-8 transition-[outline-color] duration-300 ${
        accepted ? "outline-ember/50" : "outline-transparent"
      }`}
    >
      <div className="flex items-center gap-3.5">
        <span className="flex w-13 shrink-0 flex-col items-center leading-none">
          <span className="text-[10px] uppercase tracking-[0.24em] text-mocha">{c.weekdayShort}</span>
          <span className="font-serif text-[40px] font-light lining-nums">{c.day}</span>
        </span>
        <div className="flex min-w-0 flex-col gap-[3px]">
          <span className="font-serif text-[25px] leading-[1.1] italic">{c.name}</span>
          <span className="text-[13px] text-mocha">{whenLine(c)}</span>
        </div>
      </div>
      <div role="radiogroup" aria-label={`Will you join us for the ${c.name.toLowerCase()}?`} className="grid gap-2 sm:grid-cols-2">
        {choices.map((o) => {
          const on = value === o.value;
          return (
            <label
              key={o.value}
              className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-full border px-4 text-sm transition-[background-color,border-color,color,box-shadow,translate] duration-200 active:translate-y-px has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ember ${
                on
                  ? `${o.on} font-medium shadow-[var(--shadow-seg)]`
                  : "border-stone bg-white text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.08)] [@media(hover:hover)]:hover:border-mocha"
              }`}
            >
              <input
                type="radio"
                name={answerField(c.id)}
                value={o.value}
                checked={on}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={`flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200 ${
                  on ? o.mark : "border-stone bg-white"
                }`}
              >
                <Icon
                  name="check"
                  size={12}
                  strokeWidth={2.4}
                  className={`transition-transform duration-300 ${settle} ${on ? "scale-100" : "scale-0"}`}
                />
              </span>
              {o.label}
            </label>
          );
        })}
      </div>
    </div>
  );
}
