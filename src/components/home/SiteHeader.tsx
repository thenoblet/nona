"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { couple } from "@/content/wedding";
import type { Mode } from "@/lib/mode";
import { Icon } from "@/components/ui/Icon";

type NavItem = {
  href: string;
  label: string;
  /** The words in the phone menu, where there is room for more than on a laptop. */
  menuLabel?: string;
};

/** The order of the day: "Programme" fits the laptop's row of links, the phone menu says it in full. */
const programme: NavItem = { href: "/programme", label: "Programme", menuLabel: "Order of the day" };
/** The places to stay, on their own page. */
const stay: NavItem = { href: "/stay", label: "Where to stay" };

const nav: Record<Mode, { links: NavItem[]; cta: NavItem }> = {
  before: {
    links: [
      { href: "#story", label: "Our story" },
      { href: "#celebrations", label: "Celebrations" },
      programme,
      { href: "#map", label: "Map" },
      stay,
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
      programme,
      { href: "#map", label: "Map" },
    ],
    cta: { href: "/album", label: "Share photos" },
  },
  after: {
    links: [
      { href: "#album", label: "Album" },
      { href: "#wishes", label: "Wishes" },
      { href: "#story", label: "Our story" },
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
 *
 * On another page than the home page (`current`, such as "/programme"), the home page's links lead
 * back to it, and that page's own link is marked as the one you are on.
 */
export function SiteHeader({ mode, current }: { mode: Mode; current?: string }) {
  const [open, setOpen] = useState(false);
  const { links: homeLinks, cta: homeCta } = nav[mode];
  const onHome = current === undefined;
  const fromHere = (item: NavItem): NavItem => (onHome || !item.href.startsWith("#") ? item : { ...item, href: `/home${item.href}` });
  const links = homeLinks.map(fromHere);
  const cta = fromHere(homeCta);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
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
          <Link href={onHome ? "#top" : "/home"} className="py-1.5 font-script text-[34px] leading-none text-ember no-underline" onClick={() => setOpen(false)}>
            {couple.monogram}
          </Link>
  
          <div className="hidden items-center gap-5 text-xs uppercase tracking-[0.2em] lg:flex xl:gap-7">
            {links.map((link) => {
              const here = link.href === current;
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={here ? "page" : undefined}
                  className={`py-3.5 text-white no-underline transition-colors hover:text-ember ${here ? "underline decoration-ember decoration-1 underline-offset-[7px]" : ""}`}
                >
                  {link.label}
                </a>
              );
            })}
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
              onClick={() => setOpen((isOpen) => !isOpen)}
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
              {links.map((link, index) => (
                <li
                  key={link.href}
                  className={`border-b border-hairline transition-[opacity,translate] last:border-0 ${open ? `translate-y-0 opacity-100 ${opening}` : `-translate-y-2 opacity-0 ${closing}`}`}
                  style={{ transitionDelay: open ? `${60 + index * 40}ms` : "0ms" }}
                >
                  <a
                    href={link.href}
                    onClick={() => setOpen(false)}
                    aria-current={link.href === current ? "page" : undefined}
                    className="flex min-h-13 items-center font-serif text-[26px] italic no-underline transition-colors hover:text-ember-ink"
                  >
                    {link.menuLabel ?? link.label}
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
