"use client";

import { useEffect, useState } from "react";

export type IndexEntry = { id: string; name: string; when: string };

/**
 * Which celebration is on screen: the last one whose section has reached the upper part of the
 * window, so the index follows the reader down the page.
 */
function useSectionInView(ids: readonly string[]): string | undefined {
  const [inView, setInView] = useState<string | undefined>(ids[0]);
  useEffect(() => {
    const sections = ids.flatMap((id) => {
      const element = document.getElementById(id);
      return element ? [element] : [];
    });
    if (sections.length === 0) return;
    const pick = () => {
      const line = window.innerHeight * 0.35;
      const reached = sections.filter((section) => section.getBoundingClientRect().top <= line);
      setInView((reached.at(-1) ?? sections[0]).id);
    };
    pick();
    const observer = new IntersectionObserver(pick, { rootMargin: "-35% 0px -64% 0px" });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [ids]);
  return inView;
}

/**
 * The celebrations as a way to jump through the programme. Phones get a row of chips that stays
 * at the top while scrolling; laptops a card beside the timelines. The one being read is marked.
 */
export function ProgrammeIndex({ entries, layout }: { entries: IndexEntry[]; layout: "chips" | "card" }) {
  const [ids] = useState(() => entries.map((entry) => entry.id));
  const inView = useSectionInView(ids);

  if (layout === "chips") {
    return (
      <nav
        aria-label="Celebrations"
        className="sticky top-0 z-20 flex gap-2 overflow-x-auto border-b border-hairline bg-white/95 px-4 py-3 backdrop-blur-sm lg:hidden"
      >
        {entries.map((entry) => {
          const here = entry.id === inView;
          return (
            <a
              key={entry.id}
              href={`#${entry.id}`}
              aria-current={here ? "location" : undefined}
              className={`inline-flex min-h-10 flex-none items-center rounded-full px-4 text-[11px] uppercase tracking-[0.16em] no-underline transition-colors ${
                here ? "bg-cocoa text-white" : "border border-stone text-cocoa"
              }`}
            >
              {entry.name}
            </a>
          );
        })}
      </nav>
    );
  }

  return (
    <nav aria-label="Celebrations" className="sticky top-28 flex flex-col gap-1.5 rounded-md bg-tray p-4.5">
      <p className="m-0 px-2.5 pt-1 pb-2 text-[10.5px] uppercase tracking-[0.24em] text-mocha">The celebrations</p>
      {entries.map((entry) => {
        const here = entry.id === inView;
        return (
          <a
            key={entry.id}
            href={`#${entry.id}`}
            aria-current={here ? "location" : undefined}
            className={`flex items-stretch gap-3.5 rounded-md px-2.5 py-3 no-underline transition-colors ${
              here ? "bg-white shadow-[0_1px_2px_rgba(61,41,39,0.06)]" : "hover:bg-white/60"
            }`}
          >
            <span aria-hidden className={`w-[3px] flex-none rounded-full ${here ? "bg-ember" : ""}`} />
            <span className="flex flex-col">
              <span className="font-serif text-[22px] text-cocoa italic">{entry.name}</span>
              <span className="text-xs text-mocha">{entry.when}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
