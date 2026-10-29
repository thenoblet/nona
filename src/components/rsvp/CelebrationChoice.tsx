"use client";

import type { Celebration } from "@/content/wedding";
import type { Answer } from "@/lib/data/types";
import { Segmented } from "@/components/ui/Segmented";
import { answerField } from "./options";

const choices: { value: Answer; label: string; tone?: "white" | "mocha" }[] = [
  { value: "yes", label: "Joyfully accept" },
  { value: "no", label: "Regretfully decline", tone: "mocha" },
];

/** The part before the first separator: "[Start time] · please be seated early" becomes "[Start time]". */
const lead = (s: string, sep: string) => s.split(sep)[0].trim();

/** The place without its town: "BN 111 Katakyie St, Tepa" becomes "BN 111 Katakyie St". */
const withoutTown = (s: string) => (s.includes(",") ? s.slice(0, s.lastIndexOf(",")).trim() : s);

/** "[Start time] · Assemblies of God, Victory Worship Centre": a short time and place for the card. */
export function whenLine(c: Celebration) {
  return `${lead(c.time, " · ")} · ${withoutTown(c.place)}`;
}

/** One white card per celebration, with the accept / decline switch. */
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
      <Segmented
        options={choices}
        value={value ?? null}
        onChange={onChange}
        label={`Will you join us for the ${c.name.toLowerCase()}?`}
      />
      <input type="hidden" name={answerField(c.id)} value={value ?? ""} />
    </div>
  );
}
