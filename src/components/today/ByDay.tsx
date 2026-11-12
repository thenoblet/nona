import { cache, Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { getSiteContent } from "@/lib/content/get";
import type { SiteContent } from "@/lib/content/schema";

/** The content and the moment the page was asked for, so every piece agrees on what is on now. */
type Render = (content: SiteContent, now: Date) => ReactNode;

/** Shared by every ByDay on a page, so the content is read once per request. */
const loadDay = cache(async () => {
  await connection();
  const content = await getSiteContent();
  return { content, now: new Date() };
});

async function AtRequest({ render }: { render: Render }) {
  const { content, now } = await loadDay();
  return render(content, now);
}

/**
 * Renders a piece of the page from content read at request time, at the moment it was asked for.
 * The fallback is a static placeholder, so no content is read in the prerendered shell.
 */
export function ByDay({ fallback, render }: { fallback: ReactNode; render: Render }) {
  return (
    <Suspense fallback={fallback}>
      <AtRequest render={render} />
    </Suspense>
  );
}
