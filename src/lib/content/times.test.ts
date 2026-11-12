import { describe, expect, it } from "vitest";
import { readClock } from "./schema";
import { formatClock } from "./times";

describe("formatClock", () => {
  it("shows a 24-hour time as guests read it", () => {
    expect(formatClock("14:30")).toBe("2:30 PM");
    expect(formatClock("09:05")).toBe("9:05 AM");
    expect(formatClock("12:00")).toBe("12:00 PM");
    expect(formatClock("00:15")).toBe("12:15 AM");
  });

  it("leaves anything else as typed", () => {
    expect(formatClock("Afternoon")).toBe("Afternoon");
  });
});

describe("readClock", () => {
  it("reads typed times as 24-hour times", () => {
    expect(readClock("14:30")).toBe("14:30");
    expect(readClock("9.30")).toBe("09:30");
    expect(readClock("2:30 PM")).toBe("14:30");
    expect(readClock("12 am")).toBe("00:00");
    expect(readClock("11:00 a.m.")).toBe("11:00");
  });

  it("reads nothing from words, placeholders, bare numbers or impossible times", () => {
    for (const typed of ["Afternoon", "[Time]", "10", "25:00", "13:00 PM", "Sun 6 Dec"]) {
      expect(readClock(typed)).toBeUndefined();
    }
  });
});
