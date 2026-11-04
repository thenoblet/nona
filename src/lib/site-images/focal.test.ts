import { describe, expect, it } from "vitest";
import { coverCrop, focalFromPosition, isFocal, objectPosition } from "./focal";

describe("focalFromPosition", () => {
  it("reads the built-in photos' object-positions", () => {
    expect(focalFromPosition("center 30%")).toEqual({ x: 0.5, y: 0.3 });
    expect(focalFromPosition("30% 40%")).toEqual({ x: 0.3, y: 0.4 });
    expect(focalFromPosition("center")).toEqual({ x: 0.5, y: 0.5 });
    expect(focalFromPosition("top")).toEqual({ x: 0.5, y: 0 });
    expect(focalFromPosition("left 20%")).toEqual({ x: 0, y: 0.2 });
  });

  it("takes the centre for anything it can't read", () => {
    expect(focalFromPosition(undefined)).toEqual({ x: 0.5, y: 0.5 });
    expect(focalFromPosition("calc(10px)")).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("objectPosition", () => {
  it("writes the focal point as percentages, kept inside the photo", () => {
    expect(objectPosition({ x: 0.36, y: 0.24 })).toBe("36% 24%");
    expect(objectPosition({ x: 1.4, y: -0.2 })).toBe("100% 0%");
    expect(objectPosition({ x: 0.3333, y: 0.5 })).toBe("33.3% 50%");
  });
});

describe("isFocal", () => {
  it("accepts 0–1 on both axes and nothing else", () => {
    expect(isFocal({ x: 0, y: 1 })).toBe(true);
    expect(isFocal({ x: 0.5, y: 1.01 })).toBe(false);
    expect(isFocal({ x: Number.NaN, y: 0.5 })).toBe(false);
    expect(isFocal({ x: "0.5", y: 0.5 })).toBe(false);
    expect(isFocal(null)).toBe(false);
  });
});

describe("coverCrop", () => {
  it("cuts as CSS's object-fit: cover does, the overflow shared as the focal point says", () => {
    // A portrait 1000 × 2000 photo into the 1200 × 630 card: scaled to 1200 × 2400, 1770 px to lose.
    expect(coverCrop({ width: 1000, height: 2000 }, { width: 1200, height: 630 }, { x: 0.5, y: 0 })).toEqual({
      width: 1200,
      height: 2400,
      left: 0,
      top: 0,
    });
    expect(coverCrop({ width: 1000, height: 2000 }, { width: 1200, height: 630 }, { x: 0.5, y: 0.3 }).top).toBe(531);
    expect(coverCrop({ width: 1000, height: 2000 }, { width: 1200, height: 630 }, { x: 0.5, y: 1 }).top).toBe(1770);
    // A wide photo loses its sides instead.
    const wide = coverCrop({ width: 4000, height: 1000 }, { width: 1200, height: 630 }, { x: 0.25, y: 0.9 });
    expect(wide).toEqual({ width: 2520, height: 630, left: 330, top: 0 });
  });
});
