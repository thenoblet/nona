/*
 * A photo's focal point: where it matters most, from 0 to 1 across (x) and down (y). The site uses
 * it as the photo's CSS object-position, so every crop of the photo keeps that point in view, and
 * the media worker cuts a preview card's photo by the same rule (coverCrop). Pure: the worker
 * bundles it.
 */

export type Focal = { x: number; y: number };

export const CENTRE: Focal = { x: 0.5, y: 0.5 };

const KEYWORDS: Record<string, { axis: "x" | "y" | "either"; value: number }> = {
  left: { axis: "x", value: 0 },
  right: { axis: "x", value: 1 },
  top: { axis: "y", value: 0 },
  bottom: { axis: "y", value: 1 },
  center: { axis: "either", value: 0.5 },
  centre: { axis: "either", value: 0.5 },
};

/** A value kept inside 0–1, rounded to 3 places (a tenth of a percent). */
export function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}

/** Whether both coordinates are numbers from 0 to 1. */
export function isFocal(value: unknown): value is Focal {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return [x, y].every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1);
}

/**
 * The focal point an object-position names, as the built-in photos give theirs ("center 30%",
 * "30% 40%", "top"); the centre for anything it can't read.
 */
export function focalFromPosition(position: string | undefined): Focal {
  if (!position) return CENTRE;
  const parts = position.trim().toLowerCase().split(/\s+/).slice(0, 2);
  let x: number | null = null;
  let y: number | null = null;
  const pending: number[] = [];
  for (const part of parts) {
    const keyword = KEYWORDS[part];
    if (keyword?.axis === "x") x = keyword.value;
    else if (keyword?.axis === "y") y = keyword.value;
    else if (keyword) pending.push(keyword.value);
    else if (/^-?\d+(\.\d+)?%$/.test(part)) pending.push(Number(part.slice(0, -1)) / 100);
    else return CENTRE;
  }
  // Percentages and "center" fill the axes in order: across first, then down.
  for (const value of pending) {
    if (x === null) x = value;
    else if (y === null) y = value;
  }
  return { x: clampFraction(x ?? 0.5), y: clampFraction(y ?? 0.5) };
}

/** The focal point as an object-position: "50% 30%". */
export function objectPosition(focal: Focal): string {
  const percent = (value: number) => `${Math.round(clampFraction(value) * 1000) / 10}%`;
  return `${percent(focal.x)} ${percent(focal.y)}`;
}

/**
 * How object-fit: cover with this object-position cuts a `width` × `height` picture into a
 * `boxWidth` × `boxHeight` box: the size to scale it to, and where the box sits in that. The
 * overflow on each side is shared as the focal point says (CSS's own rule: the point x% across the
 * picture lines up with x% across the box), so the worker's cards crop exactly as the site does.
 */
export function coverCrop(
  picture: { width: number; height: number },
  box: { width: number; height: number },
  focal: Focal,
): { width: number; height: number; left: number; top: number } {
  const scale = Math.max(box.width / picture.width, box.height / picture.height);
  const width = Math.max(box.width, Math.round(picture.width * scale));
  const height = Math.max(box.height, Math.round(picture.height * scale));
  return {
    width,
    height,
    left: Math.round((width - box.width) * clampFraction(focal.x)),
    top: Math.round((height - box.height) * clampFraction(focal.y)),
  };
}
