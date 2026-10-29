"use client";

import { Children, useRef, useState, type ReactNode } from "react";

/**
 * Cards in a row. Phones and tablets swipe through them right to left, one at a
 * time, with the next card peeking in; from lg they sit side by side.
 * The row bleeds to the screen edge, so place it inside the usual px-5 sm:px-6 section.
 */
export function SwipeRow({ labels, children }: { labels: string[]; children: ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);

  function onScroll() {
    const el = track.current;
    if (!el) return;
    const slides = Array.from(el.children) as HTMLElement[];
    const x = el.scrollLeft;
    // The last card can't reach the left edge, so the end of the row counts as the last card.
    if (x >= el.scrollWidth - el.clientWidth - 4) {
      setActive(slides.length - 1);
      return;
    }
    const at = (i: number) => Math.abs(slides[i].offsetLeft - slides[0].offsetLeft - x);
    let nearest = 0;
    for (let i = 1; i < slides.length; i++) if (at(i) < at(nearest)) nearest = i;
    setActive(nearest);
  }

  function show(i: number) {
    const el = track.current;
    if (!el) return;
    const slides = el.children as HTMLCollectionOf<HTMLElement>;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ left: slides[i].offsetLeft - slides[0].offsetLeft, behavior: still ? "auto" : "smooth" });
  }

  return (
    <>
      {/* Vertical padding keeps the cards' tilt and shadow from being clipped by the scroller. */}
      <div
        ref={track}
        onScroll={onScroll}
        className="no-scrollbar -mx-5 -mt-8 -mb-14 flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain scroll-px-5 px-5 pt-8 pb-14 sm:-mx-6 sm:scroll-px-6 sm:px-6 lg:mx-0 lg:my-0 lg:grid lg:auto-cols-fr lg:grid-flow-col lg:gap-8 lg:overflow-visible lg:px-0 lg:py-0"
      >
        {Children.map(children, (child) => (
          <div className="flex w-[82%] shrink-0 snap-start sm:w-[58%] lg:w-auto">{child}</div>
        ))}
      </div>
      <div className="mt-6 flex justify-center lg:hidden">
        {labels.map((label, i) => (
          <button
            key={label}
            type="button"
            onClick={() => show(i)}
            aria-label={`${label}, ${i + 1} of ${labels.length}`}
            aria-current={i === active}
            className="flex min-h-11 min-w-8 items-center justify-center"
          >
            <span
              className={`h-2 rounded-full transition-[width,background-color] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                i === active ? "w-6 bg-ember" : "w-2 bg-stone"
              }`}
            />
          </button>
        ))}
      </div>
    </>
  );
}
