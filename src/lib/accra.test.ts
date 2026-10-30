import { describe, expect, it } from "vitest";
import { accraDate, accraDateTime, accraDayAndFullMonth, accraDayAndMonth, accraTime } from "./accra";

describe("Accra dates and times", () => {
  const moment = new Date("2026-10-30T23:59:00Z");

  it("gives the Accra date for file names", () => {
    expect(accraDate(moment)).toBe("2026-10-30");
  });

  it("writes the time, the day and month, and both, on a 24-hour clock", () => {
    expect(accraTime(moment)).toBe("23:59");
    expect(accraDayAndMonth(moment)).toBe("30 Oct");
    expect(accraDateTime("2026-10-28T18:02:00Z")).toBe("28 Oct, 18:02");
  });

  it("writes a calendar day as the day and the month in full, for the reply-by date", () => {
    expect(accraDayAndFullMonth("2026-11-20")).toBe("20 November");
    expect(accraDayAndFullMonth("2026-11-05")).toBe("5 November");
  });
});
