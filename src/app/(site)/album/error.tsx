"use client";

import { PageErrorNote } from "@/components/layout/PageError";

/**
 * Shown in place of the album if it breaks (a database out of reach, a script that failed to load
 * after a deploy), in the album's own look rather than the default error screen. Try again fetches
 * and draws the album afresh. Its header is drawn here, not with PhoneHeader and the icon set: an
 * error page loads with the page it guards, so it stays small.
 */
export default function AlbumError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="min-h-dvh bg-blush pb-28">
      <header className="bg-cocoa text-white">
        <div className="mx-auto w-full max-w-xl px-5 pt-5 pb-8 sm:px-8">
          {/* A plain link, a full load: the right way off a broken page, and no router code to carry.
              The same labelled pill as PhoneHeader's way out. */}
          <a
            href="/home"
            className="press -ml-1 inline-flex min-h-11 items-center gap-1.5 rounded-full border border-white/35 bg-white/10 py-2 pr-4 pl-2.5 text-[11px] uppercase tracking-[0.18em] text-white no-underline transition-[background-color,border-color] duration-200 hover:bg-white/20"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
            Home
          </a>
          <h1 className="m-0 mt-4 font-script text-[54px] leading-[1.1] font-normal sm:text-6xl">Capture it with us</h1>
        </div>
      </header>
      <PageErrorNote message="The album can't load right now. Try again in a minute." retry={retry} />
    </main>
  );
}
