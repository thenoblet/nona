import type { Slide } from "./playlist";

/** Where the slideshow asks for the latest list (src/app/slideshow/slides.json/route.ts). */
export const FEED_URL = "/slideshow/slides.json";
/** How often the list is asked for again. */
export const REFRESH_MS = 30_000;
/** How soon to try again after a refresh failed. */
export const RETRY_MS = 10_000;
/** HTTP calls give up after 10 s (CLAUDE.md). */
export const FETCH_TIMEOUT_MS = 10_000;

function isSlide(value: unknown): value is Slide {
  if (typeof value !== "object" || value === null) return false;
  const { id, src, alt, by, detail } = value as Record<string, unknown>;
  const image = typeof src === "string" || (typeof src === "object" && src !== null && typeof (src as { src?: unknown }).src === "string");
  return typeof id === "string" && image && typeof alt === "string" && typeof by === "string" && typeof detail === "string";
}

/**
 * The latest slides, or null when they couldn't be fetched (offline, timed out, a server
 * or proxy error, an answer that isn't a slide list). Never throws.
 */
export async function fetchSlides({
  fetcher = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
}: { fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<Slide[] | null> {
  // A plain controller and timer rather than AbortSignal.timeout, which older TV browsers lack.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(FEED_URL, { cache: "no-store", signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const slides = (body as { slides?: unknown } | null)?.slides;
    return Array.isArray(slides) && slides.every(isSlide) ? slides : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks for the list every 30 s and hands each new one over. A failed refresh hands over
 * nothing, so the screen keeps what it has, and is tried again after 10 s. One request at a
 * time; none while the screen is hidden. Returns a function that stops it.
 */
export function pollSlides({
  load,
  onSlides,
  isHidden,
}: {
  load: () => Promise<Slide[] | null>;
  onSlides: (slides: Slide[]) => void;
  isHidden: () => boolean;
}): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    if (!stopped) timer = setTimeout(refresh, delay);
  };

  async function refresh() {
    if (isHidden()) return schedule(REFRESH_MS);
    const slides = await load();
    if (stopped) return;
    if (slides) onSlides(slides);
    schedule(slides ? REFRESH_MS : RETRY_MS);
  }

  schedule(REFRESH_MS);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
