/**
 * Where the tucked music button rests once a guest has moved it: on the left or right side of the
 * screen, at a height kept as a share of the screen's, so the same spot suits a slightly taller or
 * shorter phone. It never rests under the sticky header or the phone tab bar.
 */
export type Side = "left" | "right";
export type Spot = { side: Side; top: number };

/** The screen, and the band the button may rest in: from `topLimit` down to `bottomLimit` (px). */
export type Room = { width: number; height: number; topLimit: number; bottomLimit: number };

function clamp(value: number, lowest: number, highest: number): number {
  return Math.min(Math.max(value, lowest), highest);
}

/** Where a button dropped with its middle at `center` settles: the nearer side, at that height. */
export function snapSpot(center: { x: number; y: number }, size: number, room: Room): Spot {
  const side: Side = center.x < room.width / 2 ? "left" : "right";
  const highest = room.topLimit;
  const lowest = Math.max(highest, room.bottomLimit - size);
  const top = clamp(center.y - size / 2, highest, lowest);
  return { side, top: room.height > 0 ? top / room.height : 0 };
}

/**
 * The spot on this screen, in pixels from the top; null when the band is too short for the button
 * (a phone turned on its side), so it goes back to its corner until it fits again.
 */
export function placeSpot(spot: Spot, size: number, room: Room): { side: Side; topPx: number } | null {
  if (room.bottomLimit - room.topLimit < size) return null;
  return { side: spot.side, topPx: clamp(spot.top * room.height, room.topLimit, room.bottomLimit - size) };
}

/** A spot as this browser stored it; anything else (missing, broken, from an older version) is none. */
export function readSpot(stored: string | null): Spot | null {
  if (!stored) return null;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return null;
    const { side, top } = value as Record<string, unknown>;
    if (side !== "left" && side !== "right") return null;
    if (typeof top !== "number" || !Number.isFinite(top) || top < 0 || top > 1) return null;
    return { side, top };
  } catch {
    return null;
  }
}
