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
          {/* A plain link, a full load: the right way off a broken page, and no router code to carry. */}
          <a href="/home" aria-label="Back to the website" className="-ml-3 flex size-11 items-center justify-center rounded-full">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 6l-6 6 6 6" />
            </svg>
          </a>
          <h1 className="m-0 mt-4 font-script text-[54px] leading-[1.1] font-normal sm:text-6xl">Capture it with us</h1>
        </div>
      </header>
      <PageErrorNote message="The album can't load right now. Try again in a minute." retry={retry} />
    </main>
  );
}
