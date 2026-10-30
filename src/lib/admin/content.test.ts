import { describe, expect, it } from "vitest";
import { sectionKeys } from "@/lib/content/schema";
import { contentSections, describeDate, isSectionKey, newerVersionMessage, parseIssues, sectionBySlug } from "./content";

describe("contentSections", () => {
  it("lists every section but the RSVP settings once, in the admin's order, with its slug and label", () => {
    expect(contentSections.map((section) => section.key).toSorted()).toEqual(
      sectionKeys.filter((key) => key !== "rsvp").toSorted(),
    );
    expect(contentSections.map((section) => [section.slug, section.label])).toEqual([
      ["celebrations", "Celebrations"],
      ["schedule", "Order of the day"],
      ["venues", "Venues"],
      ["landmarks", "Landmarks"],
      ["faq", "Questions"],
      ["travel", "Travel & stay"],
      ["gifts", "Gifts"],
      ["party", "Wedding party"],
      ["story", "Our story"],
      ["live-stream", "Live stream"],
    ]);
  });

  it("leaves the RSVP settings to the Replies page, so the Site text pages and actions refuse them", () => {
    expect(sectionBySlug("rsvp")).toBeUndefined();
    expect(isSectionKey("rsvp")).toBe(false);
    expect(isSectionKey("faq")).toBe(true);
  });

  it("finds a section by its slug only", () => {
    expect(sectionBySlug("live-stream")?.key).toBe("liveStream");
    expect(sectionBySlug("liveStream")).toBeUndefined();
    expect(sectionBySlug("nope")).toBeUndefined();
  });
});

describe("describeDate", () => {
  it("names the day of a date", () => {
    expect(describeDate("2026-12-05")).toEqual({
      weekday: "Saturday",
      weekdayShort: "Sat",
      day: "05",
      month: "December",
      long: "Saturday 5 December 2026",
    });
    expect(describeDate("2027-01-31")?.long).toBe("Sunday 31 January 2027");
  });

  it("gives nothing for a date that isn't one", () => {
    expect(describeDate("")).toBeNull();
    expect(describeDate("2026-02-30")).toBeNull();
    expect(describeDate("5 Dec")).toBeNull();
  });
});

describe("parseIssues", () => {
  it("splits the store's messages into field paths, section-wide problems and other messages", () => {
    expect(
      parseIssues("celebrations", [
        "celebrations[0].startTime: Use a 24-hour time like 14:30",
        "celebrations: Keep the white wedding, reception and thanksgiving, each once",
        "nancy@example.com saved a newer version at 21:14 on 30 Oct. Reload to see it.",
      ]),
    ).toEqual([
      { path: "0.startTime", message: "Use a 24-hour time like 14:30" },
      { path: "", message: "Keep the white wedding, reception and thanksgiving, each once" },
      { path: null, message: "nancy@example.com saved a newer version at 21:14 on 30 Oct. Reload to see it." },
    ]);
    expect(parseIssues("venues", ["venues.hotel.coords.lat: Use a number like 7.019267"])).toEqual([
      { path: "hotel.coords.lat", message: "Use a number like 7.019267" },
    ]);
    expect(parseIssues("landmarks", ["landmarks[1]: Cannot be empty"])).toEqual([{ path: "1", message: "Cannot be empty" }]);
  });

  it("does not read another section's or an email's prefix as a path", () => {
    expect(parseIssues("faq", ["faq@example.com saved a newer version. Reload to see it."])[0].path).toBeNull();
    expect(parseIssues("faq", ["party[0].name: Cannot be empty"])[0].path).toBeNull();
  });
});

describe("newerVersionMessage", () => {
  it("names who saved and when, in Accra", () => {
    const savedAt = new Date("2026-10-30T21:14:00Z");
    expect(newerVersionMessage({ savedBy: "nancy@example.com", savedAt }, "noblet@example.com")).toBe(
      "nancy@example.com saved a newer version at 21:14 on 30 Oct. Reload to see it.",
    );
    expect(newerVersionMessage({ savedBy: "noblet@example.com", savedAt }, "noblet@example.com")).toBe(
      "You saved a newer version at 21:14 on 30 Oct. Reload to see it.",
    );
  });
});
