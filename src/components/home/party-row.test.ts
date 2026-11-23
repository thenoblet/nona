import { describe, expect, it } from "vitest";
import { partyRowWidth } from "./Sections";

describe("partyRowWidth", () => {
  it("leaves up to seven portraits on one row", () => {
    expect(partyRowWidth(4)).toBeUndefined();
    expect(partyRowWidth(7)).toBeUndefined();
  });

  it("splits eight into two rows of four, and nine into five and four", () => {
    expect(partyRowWidth(8)).toBe(`${4 * 140 + 3 * 36}px`);
    expect(partyRowWidth(9)).toBe(`${5 * 140 + 4 * 36}px`);
  });
});
