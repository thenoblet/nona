import "server-only";
import { connection } from "next/server";
import { getSiteContent } from "@/lib/content/get";
import { listMedia } from "@/lib/data/media";
import type { MediaItem } from "@/lib/data/types";
import type { Slide } from "@/components/slideshow/playlist";

type ShownMedia = MediaItem & { src: NonNullable<MediaItem["src"]> };

/** Newest first, skipping anything without a preview yet. */
async function recentMedia(): Promise<ShownMedia[]> {
  // TODO: Plan 2 swaps in the real album media here (newest first, never a photo the couple
  // hid), and the slideshow keeps polling for it every 30 s (src/components/slideshow/feed.ts),
  // with new arrivals shown next. Sample media until then.
  await connection();
  const items = await listMedia();
  return items
    .filter((item): item is ShownMedia => item.src !== null)
    .sort((first, second) => second.uploadedAt.localeCompare(first.uploadedAt));
}

function ago(minutes: number) {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** The slideshow's list, for the page and for its refreshes. Request time only. */
export async function loadSlides(): Promise<Slide[]> {
  // Media first: it waits for the request, so the content is not read while prerendering.
  const items = await recentMedia();
  const { celebrations } = await getSiteContent();
  const newest = items[0] ? Date.parse(items[0].uploadedAt) : 0;

  return items.map((item) => {
    const event = celebrations.find((celebration) => celebration.id === item.event)?.name ?? "";
    // TODO: measure against the real clock once uploads are live (sample times are in December).
    const minutes = Math.round((newest - Date.parse(item.uploadedAt)) / 60000);
    return {
      id: item.id,
      src: item.src,
      alt: item.alt,
      position: item.position,
      kind: item.kind,
      // "You" only makes sense on the uploader's own phone.
      by: item.uploaderName === "You" ? "[Guest]" : item.uploaderName,
      detail: `${event} · ${ago(minutes)}`,
    };
  });
}
