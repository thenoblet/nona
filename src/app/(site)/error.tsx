"use client";

import { PageErrorNote } from "@/components/layout/PageError";

/**
 * Shown in place of a page of the site (home, RSVP, the day's page) if it breaks, in the site's
 * own look rather than the default error screen; the album and the wishes wall have their own. Try
 * again fetches and draws the page afresh. Small on purpose: it loads with every page it guards.
 */
export default function SiteError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="min-h-dvh bg-white pb-28">
      <PageErrorNote message="This page can't load right now. Try again in a minute." retry={retry} />
      <p className="mt-6 text-center">
        {/* A plain link, a full load: the right way off a broken page, and no router code to carry. */}
        <a href="/home" className="ember-link py-3 text-[11px] uppercase tracking-[0.18em] text-cocoa no-underline">
          Back to the website
        </a>
      </p>
    </main>
  );
}
