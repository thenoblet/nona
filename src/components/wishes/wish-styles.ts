import type { Wish } from "@/lib/data/types";

/**
 * The papers a written wish can be on. A very short one ("Congratulations!") is always the big
 * ember card; any other gets one of the rest, picked from its id.
 */
export const wishCardStyles = ["letter", "taped", "keepsake", "postcard", "ticket", "envelope"] as const;

export type WishCardStyle = (typeof wishCardStyles)[number] | "short";

/** The most characters a wish can have and still be set large on the ember card. */
export const SHORT_WISH_LENGTH = 32;

export function isShortWish(message: string): boolean {
  const trimmed = message.trim();
  return !trimmed.includes("\n") && [...trimmed].length <= SHORT_WISH_LENGTH;
}

/** FNV-1a: a small, stable hash, so a wish's paper is the same on every page and every visit. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let position = 0; position < text.length; position++) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Each written wish's card style, by wish id. The list is the wall's, newest first; styles are
 * given from the oldest up, each from its own id, moved on one when it would repeat the written
 * wish before it. A new wish only ever lands on top, so the cards already on the wall keep theirs.
 */
export function pickWishStyles(wishes: readonly Pick<Wish, "id" | "kind" | "message">[]): Map<string, WishCardStyle> {
  const styles = new Map<string, WishCardStyle>();
  let previous: WishCardStyle | null = null;
  for (let position = wishes.length - 1; position >= 0; position--) {
    const wish = wishes[position];
    if (wish.kind !== "text") continue;
    let style: WishCardStyle;
    if (isShortWish(wish.message ?? "")) {
      style = "short";
    } else {
      let choice = hashOf(wish.id) % wishCardStyles.length;
      if (wishCardStyles[choice] === previous) choice = (choice + 1) % wishCardStyles.length;
      style = wishCardStyles[choice];
    }
    styles.set(wish.id, style);
    previous = style;
  }
  return styles;
}
