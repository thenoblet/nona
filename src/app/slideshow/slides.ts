import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import { accraDayAndMonth } from "@/lib/accra";
import { getSiteContent } from "@/lib/content/get";
import type { Celebration } from "@/lib/content/schema";
import { CELEBRATION_LABELS } from "@/lib/media/album-item";
import { ALBUM_SLIDES_TAG } from "@/lib/media/moderation";
import { getSlideshowDelaySeconds } from "@/lib/media/slideshow-delay";
import { listSlideshowItems, type SlideshowItem } from "@/lib/media/slideshow";
import type { Slide } from "@/components/slideshow/playlist";

/**
 * The album's moments for the slideshow, kept 15 s for every screen showing it (the venue TV and
 * guests' phones each ask every 30 s): Next's in-memory cache drops an entry once its `revalidate`
 * has passed (it hands out no stale copies in production), so `expire` only has to be longer, as
 * Next requires, and under 5 minutes, so the list is never prerendered. Under the album-slides tag,
 * which every hide drops (the remove route's revalidateTag, the admin's updateTag), as does a change
 * to the TV delay; a moment newly ready waits out the lifetime. The delay is read inside, so a list
 * is always cut by the delay in force when it was read: kept a while, it only holds older moments.
 */
async function cachedSlideshowItems(): Promise<SlideshowItem[]> {
  "use cache";
  cacheTag(ALBUM_SLIDES_TAG);
  cacheLife({ stale: 15, revalidate: 15, expire: 30 });
  return listSlideshowItems(await getSlideshowDelaySeconds());
}

/** How long ago, by the request's clock: "just now", "12 min ago", "3 h ago", then the day ("28 Nov"). */
function agoWords(listedAt: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(listedAt)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return accraDayAndMonth(new Date(listedAt));
}

function toSlide(item: SlideshowItem, celebrations: Celebration[], now: number): Slide {
  // The celebration as the site names it; another day's moment, as the album names it.
  const celebration = celebrations.find((known) => known.id === item.celebration)?.name ?? CELEBRATION_LABELS[item.celebration];
  return {
    id: item.id,
    kind: item.kind,
    src: item.view,
    width: item.width,
    height: item.height,
    by: item.by,
    detail: `${celebration} · ${agoWords(item.listedAt, now)}`,
  };
}

/** The slideshow's list, for the page and for its refreshes. Request time only. */
export async function loadSlides(): Promise<Slide[]> {
  // First: the album is read at request time, never while the page is prerendered.
  await connection();
  const [items, { celebrations }] = await Promise.all([cachedSlideshowItems(), getSiteContent()]);
  const now = Date.now();
  return items.map((item) => toSlide(item, celebrations, now));
}
