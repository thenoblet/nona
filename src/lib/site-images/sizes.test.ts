import { describe, expect, it } from "vitest";
import { sizeCandidates, widthAtLongEdge } from "./sizes";

const derived = {
  thumb: "derived/m/h/thumb.webp",
  view: "derived/m/h/view.webp",
  medium: "derived/m/h/medium.webp",
  large: "derived/m/h/large.webp",
};

describe("widthAtLongEdge", () => {
  it("shrinks by the long edge and never enlarges", () => {
    expect(widthAtLongEdge(4000, 3000, 1600)).toBe(1600);
    expect(widthAtLongEdge(3000, 4000, 1600)).toBe(1200);
    expect(widthAtLongEdge(800, 600, 1600)).toBe(800);
  });
});

describe("sizeCandidates", () => {
  it("lists a landscape site photo's four sizes, narrowest first, for a full-width slot", () => {
    const candidates = sizeCandidates({ width: 6000, height: 4000, derived }, 2880);
    expect(candidates.map((candidate) => [candidate.variant, candidate.width])).toEqual([
      ["thumb", 480],
      ["medium", 960],
      ["view", 1600],
      ["large", 2400],
    ]);
  });

  it("stops at the first size as wide as the slot ever needs", () => {
    expect(sizeCandidates({ width: 6000, height: 4000, derived }, 240).map((candidate) => candidate.variant)).toEqual(["thumb"]);
    expect(sizeCandidates({ width: 6000, height: 4000, derived }, 640).map((candidate) => candidate.variant)).toEqual([
      "thumb",
      "medium",
    ]);
  });

  it("orders a portrait photo's sizes by their real widths", () => {
    // 3000 × 4500: the thumbnail is 320 wide, the viewing size 1067, medium 960, large 2400.
    const candidates = sizeCandidates({ width: 3000, height: 4500, derived }, 2880);
    expect(candidates.map((candidate) => [candidate.variant, candidate.width])).toEqual([
      ["thumb", 320],
      ["medium", 960],
      ["view", 1067],
      ["large", 2400],
    ]);
  });

  it("lists each width once for a small photo, and leaves out sizes the worker didn't make", () => {
    // 900 wide: medium, view and large are all the photo itself.
    expect(sizeCandidates({ width: 900, height: 600, derived }, 2880).map((candidate) => candidate.width)).toEqual([480, 900]);
    // An album photo has only the thumbnail and the viewing size.
    const album = { thumb: derived.thumb, view: derived.view };
    expect(sizeCandidates({ width: 6000, height: 4000, derived: album }, 2880).map((candidate) => candidate.variant)).toEqual([
      "thumb",
      "view",
    ]);
  });
});
