import "server-only";
import { photos } from "@/content/images";
import type { MediaFilter, MediaItem } from "./types";

// The media table's queries live in src/lib/media/rows.ts, which the worker can bundle (this file
// can't, for the stub's image imports). The app reaches them here too.
export { isVisible } from "@/lib/media/rows";

/**
 * STUB, below. A fixed set of sample uploads built from the couple's photos, until the album
 * (Task 15) and the slideshow and home counts (Task 20) read the media table.
 */

/** The stand-in "this phone" so My uploads has something to show. */
export const SAMPLE_DEVICE = "sample-device";

const pool = [
  photos.nancySmile,
  photos.embraceBw,
  photos.chrysanthemumsPortrait,
  photos.bouquet,
  photos.kiss,
  photos.daisiesWrapped,
  photos.earlyDays,
  photos.howWeMetBw,
  photos.chrysanthemumsWide,
];

const seed: [MediaItem["event"], boolean, boolean][] = [
  ["reception", false, false],
  ["ceremony", true, true],
  ["reception", false, false],
  ["thanks", false, false],
  ["ceremony", false, false],
  ["reception", true, false],
  ["reception", false, true],
  ["thanks", false, false],
  ["ceremony", false, false],
  ["reception", true, false],
  ["thanks", false, false],
  ["ceremony", false, true],
  ["ceremony", true, false],
  ["reception", false, false],
  ["ceremony", false, false],
];

const durations = ["0:42", "1:05", "0:18", "0:33", "0:27"];
const base = Date.parse("2026-12-05T15:00:00Z");

const sample: MediaItem[] = seed.map(([event, isVideo, mine], i) => {
  const photo = pool[i % pool.length];
  return {
    id: `sample-${i + 1}`,
    kind: isVideo ? "video" : "photo",
    // Every seventh tile has no preview yet, like a video still processing.
    src: i % 7 === 6 ? null : photo.src,
    alt: (isVideo ? "Video: " : "") + photo.alt,
    position: photo.position,
    event,
    duration: isVideo ? durations[i % durations.length] : undefined,
    uploaderName: mine ? "You" : "[Guest]",
    uploaderDevice: mine ? SAMPLE_DEVICE : `guest-${i}`,
    uploadedAt: new Date(base - i * 4 * 60 * 1000).toISOString(),
  };
});

export async function listMedia(filter: MediaFilter = {}): Promise<MediaItem[]> {
  return sample.filter(
    (m) =>
      (!filter.event || filter.event === "all" || m.event === filter.event) &&
      (!filter.device || m.uploaderDevice === filter.device),
  );
}

export async function mediaStats() {
  // Placeholder numbers, shown in brackets on the page until real counts exist.
  return { moments: "[1,240]", guests: "[180]", today: "[86]" };
}
