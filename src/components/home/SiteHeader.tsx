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
    ],
    cta: { href: "/rsvp", label: "RSVP" },
  },
  day: {
    links: [
      { href: "#today", label: "Today" },
      { href: "#album", label: "Album" },
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

/**
 * Phones: monogram, the main action and a menu button that drops the links down.
 * Desktop (lg): the links sit inline.
 */
export function SiteHeader({ mode }: { mode: Mode }) {
  const [open, setOpen] = useState(false);
  const { links, cta } = nav[mode];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
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
            <Icon name={open ? "close" : "menu"} size={22} strokeWidth={1.6} />
          </button>
        </div>
      </nav>

      <div
        id="site-menu"
        hidden={!open}
        className="border-t border-white/10 bg-cocoa lg:hidden"
      >
        <ul className="mx-auto flex max-w-[1200px] list-none flex-col px-4 py-2 sm:px-6">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                onClick={() => setOpen(false)}
                className="flex min-h-12 items-center border-b border-white/10 font-serif text-2xl text-white italic no-underline"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </header>
  );
}
