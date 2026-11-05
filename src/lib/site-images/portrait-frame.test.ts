import { describe, expect, it } from "vitest";
import { framePortrait, PORTRAIT_HEADROOM, type RawImage } from "./portrait-frame";

const BLUSH = [241, 229, 223] as const;

/** A flat blush photo with a dark oval head and wider shoulders below it, as a supplied portrait. */
function syntheticPortrait({
  width = 1280,
  height = 720,
  head = { centreX: 620, centreY: 170, radiusX: 120, radiusY: 155 },
  shouldersFrom = 330,
  shoulders = { left: 380, right: 880 },
  corner = BLUSH,
}: {
  width?: number;
  height?: number;
  head?: { centreX: number; centreY: number; radiusX: number; radiusY: number };
  shouldersFrom?: number;
  shoulders?: { left: number; right: number };
  corner?: readonly [number, number, number];
} = {}): RawImage {
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const across = (column - head.centreX) / head.radiusX;
      const down = (row - head.centreY) / head.radiusY;
      const inHead = across * across + down * down <= 1;
      const inShoulders = row >= shouldersFrom && column >= shoulders.left && column <= shoulders.right;
      const inCorner = row < 12 && column < 12;
      const colour = inHead ? [60, 40, 35] : inShoulders ? [50, 55, 70] : inCorner ? corner : BLUSH;
      data.set(colour, (row * width + column) * 3);
    }
  }
  return { data, width, height, channels: 3 };
}

describe("framePortrait", () => {
  it("finds the background, the top of the head and where the shoulders start", () => {
    const frame = framePortrait(syntheticPortrait());
    expect(frame.background).toEqual([...BLUSH]);
    // The oval's very tip is a pixel or two wide, which reads as noise, not the head.
    expect(frame.head.top).toBeGreaterThanOrEqual(15);
    expect(frame.head.top).toBeLessThanOrEqual(17);
    expect(frame.head.bottom).toBeGreaterThanOrEqual(318);
    expect(frame.head.bottom).toBeLessThanOrEqual(332);
    expect(frame.head.centre).toBeCloseTo(620, -1);
  });

  it("crops head and shoulders at 3:4, centred on the head, with headroom above it", () => {
    const { crop, head } = framePortrait(syntheticPortrait());
    expect(crop.width * 4).toBeCloseTo(crop.height * 3, -1);
    expect(crop.left + crop.width / 2).toBeCloseTo(head.centre, -1);
    // The head's top sits the same share down every portrait: above the photo's own top here, so padded.
    expect(crop.top).toBeLessThan(0);
    expect((head.top - crop.top) / crop.height).toBeCloseTo(PORTRAIT_HEADROOM, 2);
    // The head fills about half the frame's height.
    expect((head.bottom - head.top) / crop.height).toBeGreaterThan(0.4);
    expect((head.bottom - head.top) / crop.height).toBeLessThan(0.5);
  });

  it("never runs past the photo's bottom, where the subject is cut off: a big head gets a tighter frame", () => {
    const image = syntheticPortrait({ head: { centreX: 600, centreY: 220, radiusX: 160, radiusY: 216 }, shouldersFrom: 440, shoulders: { left: 360, right: 900 } });
    const { crop, head } = framePortrait(image);
    expect(crop.top + crop.height).toBeLessThanOrEqual(image.height);
    expect((head.top - crop.top) / crop.height).toBeCloseTo(PORTRAIT_HEADROOM, 2);
  });

  it("refuses a photo whose background isn't one flat colour", () => {
    expect(() => framePortrait(syntheticPortrait({ corner: [20, 120, 30] }))).toThrow(/flat background/);
  });

  it("refuses a photo with nobody in it", () => {
    const blank = syntheticPortrait({ head: { centreX: -500, centreY: -500, radiusX: 1, radiusY: 1 }, shouldersFrom: 10_000 });
    expect(() => framePortrait(blank)).toThrow(/no one/);
  });
});
