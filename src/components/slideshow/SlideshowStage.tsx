"use client";

import { useEffect, useState } from "react";
import type { MediaItem } from "@/lib/data/types";
import { MediaImage } from "@/components/album/MediaImage";

export type Slide = Pick<MediaItem, "id" | "src" | "alt" | "position" | "kind"> & {
  by: string;
  /** e.g. "Reception · just now" */
  detail: string;
};

const INTERVAL = 6000;

/**
 * The big photo on the venue screen. Cross-fades to the next moment every six seconds
 * and pauses while the tab is hidden. Only the previous, current and next slides are
 * mounted, so the next photo is already loaded when its turn comes.
 */
export function SlideshowStage({ slides }: { slides: Slide[] }) {
  const [{ index, prev }, setPos] = useState<{ index: number; prev: number | null }>({ index: 0, prev: null });
  const count = slides.length;

  useEffect(() => {
    if (count < 2) return;
    let timer: number | undefined;
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => setPos((p) => ({ prev: p.index, index: (p.index + 1) % count })), INTERVAL);
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [count]);

  if (!count) {
    return (
      <div className="flex h-full items-center justify-center bg-mocha px-40 text-center">
        <p className="m-0 text-[calc(var(--spacing)*16)] tracking-[0.24em] text-linen uppercase">
          The first moments will appear here
        </p>
      </div>
    );
  }

  // TODO: play videos muted inline instead of showing their poster frame.
  const current = slides[index];
  const next = (index + 1) % count;
  const layers: { i: number; role: "current" | "next" | "prev" }[] = [{ i: index, role: "current" }];
  if (next !== index) layers.push({ i: next, role: "next" });
  if (prev !== null && prev !== index && prev !== next) layers.push({ i: prev, role: "prev" });

  return (
    <div className="relative h-full overflow-hidden bg-mocha">
      {layers.map(({ i, role }) => {
        const slide = slides[i];
        return (
          <div
            key={slide.id}
            aria-hidden={role !== "current"}
            className={`absolute inset-0 transition-opacity duration-1200 ease-in-out ${
              role === "current" ? "z-10 opacity-100" : role === "prev" ? "z-0 opacity-100" : "z-0 opacity-0"
            }`}
          >
            {/* A soft, blurred copy fills the frame behind portrait photos. */}
            <MediaImage
              item={{ ...slide, alt: "" }}
              sizes="20vw"
              loading="eager"
              className="scale-110 opacity-50 blur-2xl"
            />
            <MediaImage item={slide} sizes="75vw" loading="eager" fit="contain" />
          </div>
        );
      })}

      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center justify-between gap-24 bg-cocoa/80 px-24 py-20">
        <p className="m-0 min-w-0 truncate font-serif text-[calc(var(--spacing)*26)] italic">Shared by {current.by}</p>
        <p className="m-0 shrink-0 text-[calc(var(--spacing)*13)] tracking-[0.2em] text-ember uppercase">
          {current.detail}
        </p>
      </div>
    </div>
  );
}
