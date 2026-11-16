import { describe, expect, it } from "vitest";
import { placeSpot, readSpot, snapSpot, type Room } from "./spot";

// An iPhone 14: the header ends at 64 px, so the button rests from 76; the tab bar starts at 780,
// so its bottom edge stays above 768.
const phone: Room = { width: 390, height: 844, topLimit: 76, bottomLimit: 768 };
const size = 54;

describe("snapSpot", () => {
  it("settles on the nearer side, at the height it was dropped", () => {
    expect(snapSpot({ x: 120, y: 427 }, size, phone)).toEqual({ side: "left", top: 400 / 844 });
    expect(snapSpot({ x: 300, y: 427 }, size, phone)).toEqual({ side: "right", top: 400 / 844 });
  });

  it("never rests under the header or the tab bar", () => {
    expect(snapSpot({ x: 40, y: 10 }, size, phone)).toEqual({ side: "left", top: 76 / 844 });
    expect(snapSpot({ x: 40, y: 830 }, size, phone)).toEqual({ side: "left", top: (768 - 54) / 844 });
  });
});

describe("placeSpot", () => {
  it("turns the share of the height back into pixels", () => {
    expect(placeSpot({ side: "left", top: 400 / 844 }, size, phone)).toEqual({ side: "left", topPx: 400 });
  });

  it("keeps the spot in proportion on a shorter phone, inside its own limits", () => {
    const small: Room = { width: 375, height: 667, topLimit: 76, bottomLimit: 591 };
    expect(placeSpot({ side: "right", top: 0.5 }, size, small)).toEqual({ side: "right", topPx: 333.5 });
    expect(placeSpot({ side: "right", top: 0.85 }, size, small)).toEqual({ side: "right", topPx: 591 - 54 });
  });

  it("gives none when the band is too short for the button, so it goes back to its corner", () => {
    expect(placeSpot({ side: "left", top: 0.5 }, size, { width: 844, height: 140, topLimit: 76, bottomLimit: 120 })).toBeNull();
  });
});

describe("readSpot", () => {
  it("reads a stored spot", () => {
    expect(readSpot('{"side":"left","top":0.4}')).toEqual({ side: "left", top: 0.4 });
  });

  it("gives none for anything else", () => {
    for (const stored of [null, "", "nope", "null", "[]", '{"side":"up","top":0.4}', '{"side":"left","top":2}', '{"side":"left","top":"0.4"}']) {
      expect(readSpot(stored), String(stored)).toBeNull();
    }
  });
});
