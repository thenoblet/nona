"use client";

import { useEffect, useState } from "react";

function split(ms: number) {
  const t = Math.max(0, ms);
  const days = Math.floor(t / 864e5);
  const hours = Math.floor((t % 864e5) / 36e5);
  const mins = Math.floor((t % 36e5) / 6e4);
  const secs = Math.floor((t % 6e4) / 1000);
  return { days, hours, mins, secs };
}

/** Days, hours, minutes and seconds to the wedding. Fills in after the page loads. */
export function Countdown({ to }: { to: string }) {
  const target = Date.parse(to);
  const [left, setLeft] = useState<ReturnType<typeof split> | null>(null);

  useEffect(() => {
    const tick = () => setLeft(split(target - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);

  const pad = (n: number) => String(n).padStart(2, "0");
  const cells: [string, string][] = [
    [left ? String(left.days) : "·", "Days"],
    [left ? pad(left.hours) : "·", "Hours"],
    [left ? pad(left.mins) : "·", "Mins"],
    [left ? pad(left.secs) : "·", "Secs"],
  ];

  return (
    <div role="timer" aria-label="Countdown to the wedding" className="grid w-full max-w-[520px] grid-cols-4 gap-2 sm:gap-3">
      {cells.map(([value, label]) => (
        <div key={label} className="flex flex-col gap-1 border border-ember/50 px-1 py-3.5 sm:py-4.5">
          <span className="font-serif text-[34px] leading-none text-ember tabular-nums sm:text-[44px]">{value}</span>
          <span className="text-[10px] uppercase tracking-[0.24em] text-mist sm:text-[11px]">{label}</span>
        </div>
      ))}
    </div>
  );
}
