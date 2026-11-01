import type { DerivedVariant } from "@/lib/storage/keys";

/*
 * The sizes a site photo is served in (Ruling CI): the media worker's own WebP files on
 * MEDIA_BASE_URL, never Next's image optimiser. Every photo the worker processes gets the album's
 * two, the thumbnail and the viewing size (each by its long edge); a site photo (purpose "site")
 * gets two more by width, so a full-width photo is sharp at twice 1440 px and a small one stays
 * small. Pure: the worker makes the sizes from these numbers, and the pages list them from them.
 */

/** The album's sizes, by the long edge (stills.ts makes them). */
export const ALBUM_LONG_EDGES = { thumb: 480, view: 1600 } as const;

/** A site photo's extra sizes, by width: `medium` 960 px, `large` 2400 px. */
export const SITE_EXTRA_WIDTHS = { medium: 960, large: 2400 } as const;

/** The site's extra sizes' WebP quality, as the viewing size's. */
export const SITE_EXTRA_QUALITY = 80;

/** A size the browser may pick from: its URL's key and its width in pixels. */
export type SizeCandidate = { variant: DerivedVariant; key: string; width: number };

/** The width a picture `width` × `height` has once shrunk (never enlarged) to `longEdge` on its long edge. */
export function widthAtLongEdge(width: number, height: number, longEdge: number): number {
  const scale = Math.min(1, longEdge / Math.max(width, height));
  return Math.max(1, Math.round(width * scale));
}

/**
 * The photo's sizes, narrowest first, each width once, up to the first at least `maxWidth` wide
 * (the slot's widest at twice the pixels): a 120 px print lists only what it could ever use.
 * `derived` holds the keys the worker made; a size it didn't make is left out.
 */
export function sizeCandidates(
  photo: { width: number; height: number; derived: Partial<Record<DerivedVariant, string>> },
  maxWidth: number,
): SizeCandidate[] {
  const { width, height, derived } = photo;
  const all: SizeCandidate[] = [];
  const add = (variant: DerivedVariant, candidateWidth: number) => {
    const key = derived[variant];
    if (key) all.push({ variant, key, width: candidateWidth });
  };
  add("thumb", widthAtLongEdge(width, height, ALBUM_LONG_EDGES.thumb));
  add("medium", Math.min(width, SITE_EXTRA_WIDTHS.medium));
  add("view", widthAtLongEdge(width, height, ALBUM_LONG_EDGES.view));
  add("large", Math.min(width, SITE_EXTRA_WIDTHS.large));
  all.sort((first, second) => first.width - second.width);

  const chosen: SizeCandidate[] = [];
  for (const candidate of all) {
    if (chosen.at(-1)?.width === candidate.width) continue;
    chosen.push(candidate);
    if (candidate.width >= maxWidth) break;
  }
  return chosen;
}
