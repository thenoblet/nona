import { describe, expect, it } from "vitest";
import type { Celebration } from "@/lib/content/schema";
import { buildIcs, celebrationEvent, googleCalendarUrl } from "./ics";

const base: Celebration = {
  id: "ceremony",
  name: "White wedding",
  weekday: "Saturday",
  weekdayShort: "Sat",
  day: "05",
  month: "December",
  time: "[Start time], please be seated early",
  place: "Chapel, Tepa",
  dress: "Formal",
  directionsUrl: "#map",
  date: "2026-12-05",
  startTime: null,
  endTime: null,
};
const site = "https://example.com";
const now = new Date("2026-10-29T12:30:45Z");
const lines = (ics: string) => ics.split("\r\n");

describe("celebrationEvent", () => {
  it("maps a celebration to an event", () => {
    expect(celebrationEvent(base, site)).toEqual({
      uid: "ceremony@nobletxnancy.com",
      title: "White wedding · Noblet & Nancy",
      date: "2026-12-05",
      startTime: null,
      endTime: null,
      location: "Chapel, Tepa",
      description: "[Start time], please be seated early\nhttps://example.com",
    });
  });
});

describe("buildIcs", () => {
  it("writes an all-day event when there is no start time", () => {
    const ics = buildIcs([celebrationEvent(base, site)], now);
    const written = lines(ics);
    expect(written[0]).toBe("BEGIN:VCALENDAR");
    expect(written).toContain("X-WR-TIMEZONE:Africa/Accra");
    expect(written).toContain("DTSTART;VALUE=DATE:20261205");
    expect(written).toContain("DTEND;VALUE=DATE:20261206");
    expect(written).toContain("DTSTAMP:20261029T123045Z");
    expect(written).toContain("UID:ceremony@nobletxnancy.com");
  });

  it("uses UTC times and defaults the end to three hours later", () => {
    const ics = buildIcs([celebrationEvent({ ...base, startTime: "10:00" }, site)], now);
    expect(ics).toContain("DTSTART:20261205T100000Z\r\n");
    expect(ics).toContain("DTEND:20261205T130000Z\r\n");
  });

  it("uses the end time when given", () => {
    const ics = buildIcs([celebrationEvent({ ...base, startTime: "10:00", endTime: "12:30" }, site)], now);
    expect(ics).toContain("DTEND:20261205T123000Z\r\n");
  });

  it("ends every line with CRLF and folds at 75 octets, counting bytes", () => {
    const long = { ...base, place: "Ɛkɔm Ɔdɔ, ".repeat(30), startTime: "10:00" };
    const ics = buildIcs([celebrationEvent(long, site)], now);
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    for (const line of lines(ics.slice(0, -2))) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Unfolding restores the escaped text.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain(`LOCATION:${long.place.replace(/,/g, "\\,")}`);
  });

  it("escapes commas, semicolons, backslashes and newlines", () => {
    const event = { ...celebrationEvent(base, site), description: "a,b;c\\d\ne" };
    expect(buildIcs([event], now)).toContain("DESCRIPTION:a\\,b\\;c\\\\d\\ne\r\n");
  });
});

describe("googleCalendarUrl", () => {
  it("uses a date range for an all-day event", () => {
    const url = new URL(googleCalendarUrl(celebrationEvent(base, site)));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20261205/20261206");
    expect(url.searchParams.get("text")).toBe("White wedding · Noblet & Nancy");
    expect(url.searchParams.get("location")).toBe("Chapel, Tepa");
  });

  it("uses UTC times when the start is set", () => {
    const url = new URL(googleCalendarUrl(celebrationEvent({ ...base, startTime: "10:00" }, site)));
    expect(url.searchParams.get("dates")).toBe("20261205T100000Z/20261205T130000Z");
  });
});
