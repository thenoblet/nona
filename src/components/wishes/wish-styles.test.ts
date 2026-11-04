import { describe, expect, it } from "vitest";
import type { Wish } from "@/lib/data/types";
import { isShortWish, pickWishStyles, wishCardStyles } from "./wish-styles";

const written = (id: string, message = "May your home be full of laughter and good food."): Wish => ({
  id,
  kind: "text",
  message,
  signedAs: "Ama",
  createdAt: "2026-11-03T12:00:00.000Z",
});

const recorded = (id: string): Wish => ({ id, kind: "voice", signedAs: "Kwame", createdAt: "2026-11-03T12:00:00.000Z" });

/** Newest first, as the wall lists them. */
const wall = (count: number): Wish[] =>
  Array.from({ length: count }, (_slot, position) => written(`00000000-0000-4000-8000-${String(count - position).padStart(12, "0")}`));

describe("isShortWish", () => {
  it("takes a one-liner up to 32 characters, emoji counted as one each", () => {
    expect(isShortWish("Congratulations!")).toBe(true);
    expect(isShortWish("  ❤️  ")).toBe(true);
    expect(isShortWish("x".repeat(32))).toBe(true);
    expect(isShortWish("x".repeat(33))).toBe(false);
    expect(isShortWish("Bless you\nboth")).toBe(false);
  });
});

describe("pickWishStyles", () => {
  it("puts every short wish on the ember card and every other on one of the six papers", () => {
    const styles = pickWishStyles([written("a", "Congratulations!"), ...wall(30)]);
    expect(styles.get("a")).toBe("short");
    for (const wish of wall(30)) expect(wishCardStyles).toContain(styles.get(wish.id));
  });

  it("never gives two written wishes in a row the same paper, recordings between them aside", () => {
    const wishes = wall(60).flatMap((wish, position) => (position % 7 === 3 ? [wish, recorded(`voice-${position}`)] : [wish]));
    const styles = pickWishStyles(wishes);
    const papers = wishes.filter((wish) => wish.kind === "text").map((wish) => styles.get(wish.id));
    for (let position = 1; position < papers.length; position++) expect(papers[position]).not.toBe(papers[position - 1]);
    expect(new Set(papers).size).toBe(wishCardStyles.length);
    expect(styles.has("voice-3")).toBe(false);
  });

  it("keeps the cards already on the wall as they were when a new wish arrives on top", () => {
    const before = wall(20);
    const after = [written("ffffffff-0000-4000-8000-000000000000"), ...before];
    const earlier = pickWishStyles(before);
    const later = pickWishStyles(after);
    for (const wish of before) expect(later.get(wish.id)).toBe(earlier.get(wish.id));
  });
});
