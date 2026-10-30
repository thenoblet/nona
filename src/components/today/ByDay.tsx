import { cache, Suspense, type ReactNode } from "react";
import { connection } from "next/server";
import { getSiteContent } from "@/lib/content/get";
import type { SiteContent } from "@/lib/content/schema";
import { isSecondDay } from "@/lib/mode";

type Render = (secondDay: boolean, content: SiteContent) => ReactNode;

/** Shared by every ByDay on a page, so the content is read once per request. */
const loadDay = cache(async () => {
  await connection();
  const content = await getSiteContent();
  return { secondDay: isSecondDay(new Date()), content };
});

async function AtRequest({ render }: { render: Render }) {
  const { secondDay, content } = await loadDay();
  return render(secondDay, content);
}

/**
 * Renders a piece of the page for the right day (Sunday moves on to the thanksgiving service),
 * from content read at request time. The fallback is a static placeholder, so no content is read
 * in the prerendered shell.
 */
export function ByDay({ fallback, render }: { fallback: ReactNode; render: Render }) {
  return (
    <Suspense fallback={fallback}>
      <AtRequest render={render} />
    </Suspense>
  );
}
