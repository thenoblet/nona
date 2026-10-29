"use client";

import { useState } from "react";
import { Halo } from "@/components/ui/Halo";
import { FieldLabel, TextInput } from "@/components/ui/Field";

/** A tiny floor plan with the guest's table filled in. */
function SeatMap() {
  const tables = [
    "top-3 left-3",
    "top-3 left-14",
    "top-14 left-3",
  ];
  return (
    <div
      role="img"
      aria-label="Seating map placeholder with your table marked"
      className="relative size-22 shrink-0 rounded-[var(--radius-paper)] bg-blush"
    >
      {tables.map((pos) => (
        <span key={pos} className={`absolute size-4.5 rounded-full border border-stone ${pos}`} />
      ))}
      <span className="absolute top-14 left-14 size-4.5 rounded-full bg-ember shadow-[0_0_0_4px_var(--color-halo)]" />
    </div>
  );
}

/** "Find your seat": type your name, see your table. */
export function SeatFinder() {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const first = trimmed.split(/\s+/)[0];

  return (
    <div className="flex flex-col gap-3.5 rounded-[var(--radius-paper)] bg-white px-5 py-5.5 shadow-[var(--shadow-paper)]">
      <div className="flex items-center gap-3.5">
        <Halo icon="seat" size="lg" />
        <h2 id="seat-h" className="font-serif text-[30px] italic">
          Find your seat
        </h2>
      </div>
      <FieldLabel htmlFor="seatname">Type your name</FieldLabel>
      <TextInput
        id="seatname"
        type="text"
        autoComplete="name"
        placeholder="First and last name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div aria-live="polite">
        {trimmed.length > 1 ? (
          // TODO: look the guest up in the seating plan (from their RSVP) instead of these placeholders.
          <div className="flex animate-rise items-center justify-between gap-3.5 border-t border-hairline pt-4">
            <div className="flex flex-col gap-1">
              <span className="text-[13px] text-mocha">{first}, you&apos;re at</span>
              <span className="font-serif text-[42px] leading-none font-medium">Table [7]</span>
              <span className="text-[13px] text-mocha">[Table name] · [near the dance floor]</span>
            </div>
            <SeatMap />
          </div>
        ) : (
          <p className="font-serif text-lg leading-normal text-mocha italic">
            Use the name on your reply and we&apos;ll show you to your table.
          </p>
        )}
      </div>
    </div>
  );
}
