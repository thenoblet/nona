import { thumbHashToApproximateAspectRatio, thumbHashToAverageRGBA } from "thumbhash";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER_MAX_EDGE, placeholderOf } from "./thumbhash";

/** A `width` × `height` RGBA image, every pixel the colour `pixel` gives for its position. */
function image(
  width: number,
  height: number,
  pixel: (column: number, row: number) => [number, number, number, number],
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) rgba.set(pixel(column, row), (row * width + column) * 4);
  }
  return rgba;
}

function decoded(thumbhash: string): Uint8Array {
  return Uint8Array.from(atob(thumbhash), (character) => character.charCodeAt(0));
}

describe("placeholderOf", () => {
  it("gives the raw ThumbHash in base64, which keeps the picture's shape and colour", () => {
    const { thumbhash } = placeholderOf(100, 75, image(100, 75, () => [200, 40, 40, 255]));
    const hash = decoded(thumbhash);

    expect(thumbhash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(hash.length).toBeLessThanOrEqual(25);
    // ThumbHash keeps the shape only roughly (4:3 comes back as 1.4).
    expect(Math.abs(thumbHashToApproximateAspectRatio(hash) - 100 / 75)).toBeLessThan(0.1);
    const average = thumbHashToAverageRGBA(hash);
    expect(average.r).toBeGreaterThan(0.7);
    expect(average.g).toBeLessThan(0.25);
  });

  it("gives the average colour as #rrggbb", () => {
    // Half black, half white: the average is mid grey.
    const halves = image(100, 50, (column) => (column < 50 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    expect(placeholderOf(100, 50, halves).averageColor).toBe("#808080");
    expect(placeholderOf(10, 10, image(10, 10, () => [18, 52, 86, 255])).averageColor).toBe("#123456");
  });

  it("averages only what shows: a transparent pixel's colour doesn't count", () => {
    const halfClear = image(20, 10, (column) => (column < 10 ? [0, 0, 255, 0] : [255, 0, 0, 255]));
    expect(placeholderOf(20, 10, halfClear).averageColor).toBe("#ff0000");
  });

  it("refuses an image over 100 px, or pixels that don't match its size", () => {
    expect(PLACEHOLDER_MAX_EDGE).toBe(100);
    expect(() => placeholderOf(101, 50, new Uint8Array(101 * 50 * 4))).toThrow();
    expect(() => placeholderOf(50, 50, new Uint8Array(10))).toThrow();
  });
});
