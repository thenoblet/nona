"use client";

import { useState } from "react";
import type { EventId } from "@/content/wedding";
import type { Celebration } from "@/lib/content/schema";
import type { MediaItem } from "@/lib/data/types";
import { Halo } from "@/components/ui/Halo";
import { Segmented } from "@/components/ui/Segmented";
import { MediaTile } from "./MediaTile";
import { PersonalLinkStrip } from "./PersonalLinkOffer";

type EventFilter = EventId | "all";
type Whose = "everyone" | "mine";

/** Short chip labels for each celebration. */
const chipLabel: Record<EventId, string> = {
  ceremony: "Ceremony",
  reception: "Reception",
  thanks: "Thanksgiving",
};


/**
 * Filters (celebration chips, everyone or mine), the count line and the photo grid.
 * Filtering runs here over the full list the server sent.
 */
export function AlbumBrowser({
  celebrations,
  items,
  myDevice,
}: {
  celebrations: Celebration[];
  items: MediaItem[];
  myDevice: string;
}) {
  const chips: { id: EventFilter; label: string }[] = [
    { id: "all", label: "All" },
    ...celebrations.map((celebration) => ({ id: celebration.id, label: chipLabel[celebration.id] })),
  ];
  const [event, setEvent] = useState<EventFilter>("all");
  const [whose, setWhose] = useState<Whose>("everyone");

  const shown = items.filter(
    (item) => (event === "all" || item.event === event) && (whose === "everyone" || item.uploaderDevice === myDevice),
  );
  const mine = whose === "mine";

  return (
    <>
      <nav aria-label="Celebrations" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pt-5.5 pb-1">
        {chips.map((chip) => {
          const on = chip.id === event;
          return (
            <button
              key={chip.id}
              type="button"
              aria-pressed={on}
              onClick={() => setEvent(chip.id)}
              className={`min-h-11 shrink-0 cursor-pointer rounded-full border px-5 text-xs uppercase tracking-[0.14em] transition-[background-color,box-shadow,color] duration-200 ${
                on
                  ? "border-white bg-white text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.08),0_6px_14px_rgb(61_41_39/0.1)]"
                  : "border-stone bg-transparent text-mocha"
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </nav>

      <Segmented
        role="tablist"
        label="Whose moments"
        value={whose}
        onChange={setWhose}
        options={[
          { value: "everyone", label: "Everyone's moments" },
          { value: "mine", label: "My uploads" },
        ]}
        className="mt-3.5 sm:max-w-md"
      />

      <div className="flex items-center justify-between py-2.5">
        <p className="m-0 text-[13px] text-mocha" aria-live="polite">
          {shown.length} {shown.length === 1 ? "moment" : "moments"} (sample)
        </p>
        <button
          type="button"
          onClick={() => {
            // TODO: zip the selected moments on the server and download them.
          }}
          className="flex min-h-11 cursor-pointer items-center gap-2 text-xs uppercase tracking-[0.16em] text-cocoa"
        >
          <Halo icon="download" size="sm" />
          {mine ? "Download mine" : "Download all"}
        </button>
      </div>

      {/* The personal link's slim row (gate A). TODO(Task 15): pass the viewer's link from the server. */}
      {mine ? <PersonalLinkStrip /> : null}

      {shown.length ? (
        <ul className="m-0 grid list-none grid-cols-3 gap-1.5 p-0 md:grid-cols-4 lg:grid-cols-5">
          {shown.map((item) => (
            <MediaTile key={item.id} item={item} mine={item.uploaderDevice === myDevice} />
          ))}
        </ul>
      ) : (
        <p className="m-0 rounded-[var(--radius-paper)] bg-white px-5 py-10 text-center font-serif text-xl text-mocha italic shadow-[var(--shadow-paper)]">
          {mine ? "Nothing from this phone here yet. Share a moment above." : "No moments here yet."}
        </p>
      )}

      <p className="mt-3 mb-0 flex items-center gap-2 text-xs text-mocha">
        <span aria-hidden className="size-2.5 rounded-full border-2 border-white bg-ember shadow-[0_0_0_1px_var(--color-hairline)]" />
        Marks your own uploads
      </p>
    </>
  );
}
