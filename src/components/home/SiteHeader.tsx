"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { couple } from "@/content/wedding";
import type { Mode } from "@/lib/mode";
import { Icon } from "@/components/ui/Icon";

type NavItem = { href: string; label: string };

const nav: Record<Mode, { links: NavItem[]; cta: NavItem }> = {
  before: {
    links: [
      { href: "#story", label: "Our story" },
      { href: "#celebrations", label: "Celebrations" },
      { href: "#map", label: "Map" },
      { href: "#travel", label: "Travel" },
      { href: "#gifts", label: "Gifts" },
      { href: "#album", label: "Album" },
      { href: "/wishes", label: "Wishes" },
    ],
    cta: { href: "/rsvp", label: "RSVP" },
  },
  day: {
    links: [
      { href: "#today", label: "Today" },
      { href: "#album", label: "Album" },
      { href: "/wishes", label: "Wishes" },
      { href: "#celebrations", label: "Celebrations" },
      { href: "#map", label: "Map" },
      { href: "#gifts", label: "Gifts" },
    ],
    cta: { href: "/album", label: "Share photos" },
  },
  after: {
    links: [
      { href: "#album", label: "Album" },
      { href: "#wishes", label: "Wishes" },
      { href: "#story", label: "Our story" },
      { href: "#gifts", label: "Gifts" },
    ],
    cta: { href: "#album", label: "Relive the day" },
  },
};

/** Opening settles gently; closing gets out of the way faster. */
const opening = "duration-400 ease-[cubic-bezier(0.16,1,0.3,1)]";
const closing = "duration-200 ease-[cubic-bezier(0.4,0,1,1)]";

/**
 * Phones: monogram, the main action and a menu button that drops a paper panel
 * of links over the dimmed page. Desktop (lg): the links sit inline.
 */
export function SiteHeader({ mode }: { mode: Mode }) {
  const [open, setOpen] = useState(false);
  const { links, cta } = nav[mode];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    // Hold the page still behind the menu.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      root.style.overflow = overflow;
    };
  }, [open]);

  return (
    <>
      {/* Dims and softens the page under the open menu; a tap outside closes it. */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-30 bg-black/45 backdrop-blur-[3px] transition-opacity lg:hidden ${
          open ? `opacity-100 ${opening}` : `pointer-events-none opacity-0 ${closing}`
        }`}
      />
      <header className="sticky top-0 z-40 border-b border-ember/35 bg-cocoa text-white">
        <nav aria-label="Main" className="mx-auto flex max-w-[1200px] items-center justify-between gap-4 px-4 py-2.5 sm:px-6 lg:py-4">
          <Link href="#top" className="py-1.5 font-script text-[34px] leading-none text-ember no-underline" onClick={() => setOpen(false)}>
            {couple.monogram}
          </Link>
  
          <div className="hidden items-center gap-7 text-xs uppercase tracking-[0.2em] lg:flex">
            {links.map((l) => (
              <a key={l.href} href={l.href} className="py-3.5 text-white no-underline transition-colors hover:text-ember">
                {l.label}
              </a>
            ))}
          </div>
  
          <div className="flex items-center gap-2">
            <Link
              href={cta.href}
              className="press inline-flex min-h-11 items-center rounded-full bg-ember px-5 text-xs font-medium uppercase tracking-[0.2em] text-cocoa no-underline shadow-[var(--shadow-pill-dark)] sm:px-6.5"
            >
              {cta.label}
            </Link>
            <button
              type="button"
              className="flex size-11 cursor-pointer items-center justify-center rounded-full text-white lg:hidden"
              aria-expanded={open}
              aria-controls="site-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((o) => !o)}
            >
              <span className="relative size-[22px]">
                <Icon
                  name="menu"
                  size={22}
                  strokeWidth={1.6}
                  className={`absolute inset-0 transition-[opacity,rotate] ${open ? `rotate-90 opacity-0 ${opening}` : `rotate-0 opacity-100 ${closing}`}`}
                />
                <Icon
                  name="close"
                  size={22}
                  strokeWidth={1.6}
                  className={`absolute inset-0 transition-[opacity,rotate] ${open ? `rotate-0 opacity-100 ${opening}` : `-rotate-90 opacity-0 ${closing}`}`}
                />
              </span>
            </button>
          </div>
        </nav>
  
        {/*
          A paper panel that unfolds from under the header. Animating grid rows from
          0fr to 1fr slides it to its natural height; `invisible` waits for the close
          to finish, then takes the links out of the tab order.
        */}
        <div
          id="site-menu"
          className={`absolute inset-x-0 top-full grid bg-white text-cocoa shadow-[var(--shadow-paper-lift)] transition-[grid-template-rows,visibility] lg:hidden ${
            open ? `visible grid-rows-[1fr] ${opening}` : `invisible grid-rows-[0fr] ${closing}`
          }`}
        >
          <div className="overflow-hidden">
            <ul className="mx-auto flex max-w-[1200px] list-none flex-col px-5 pt-2 pb-5 sm:px-6">
              {links.map((l, i) => (
                <li
                  key={l.href}
                  className={`border-b border-hairline transition-[opacity,translate] last:border-0 ${open ? `translate-y-0 opacity-100 ${opening}` : `-translate-y-2 opacity-0 ${closing}`}`}
                  style={{ transitionDelay: open ? `${60 + i * 40}ms` : "0ms" }}
                >
                  <a
                    href={l.href}
                    onClick={() => setOpen(false)}
                    className="flex min-h-13 items-center font-serif text-[26px] italic no-underline transition-colors hover:text-ember-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </header>
    </>
  );
}
