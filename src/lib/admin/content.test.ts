import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { sectionKeys, sectionSchemas } from "@/lib/content/schema";
import {
  contentSections,
  describeDate,
  newerVersionMessage,
  parseIssues,
  prepareSection,
  sectionBySlug,
} from "./content";

describe("contentSections", () => {
  it("lists every section once, in the admin's order, with its slug and label", () => {
    expect(contentSections.map((section) => section.key).toSorted()).toEqual([...sectionKeys].toSorted());
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

describe("prepareSection", () => {
  it("matches the built-in celebrations' day words", () => {
    expect(prepareSection("celebrations", contentDefaults.celebrations)).toEqual(contentDefaults.celebrations);
  });

  it("turns empty optional celebration fields into null or nothing, and tidies typed times", () => {
    const [ceremony, reception] = prepareSection("celebrations", [
      { ...contentDefaults.celebrations[0], startTime: " 9:30 ", endTime: "", placeDetail: "  " },
      { ...contentDefaults.celebrations[1], startTime: "14.30", endTime: "25:00" },
    ]) as Record<string, unknown>[];
    expect(ceremony.startTime).toBe("09:30");
    expect(ceremony.endTime).toBeNull();
    expect(ceremony).not.toHaveProperty("placeDetail");
    expect(reception.startTime).toBe("14:30");
    expect(reception.endTime).toBe("25:00");
  });

  it("turns typed coordinates into numbers and drops them when both are empty", () => {
    const venues = structuredClone(contentDefaults.venues) as Record<string, Record<string, unknown>>;
    venues.church.coords = { lat: " 7.5 ", lng: "-2.25" };
    venues.reception.coords = { lat: "", lng: "" };
    venues.reception.note = "";
    venues.hotel.coords = { lat: "7", lng: "" };
    const prepared = prepareSection("venues", venues) as Record<string, Record<string, unknown>>;

    expect(prepared.church.coords).toEqual({ lat: 7.5, lng: -2.25 });
    expect(prepared.reception).not.toHaveProperty("coords");
    expect(prepared.reception).not.toHaveProperty("note");
    expect(prepared.hotel.coords).toEqual({ lat: 7, lng: undefined });

    const result = sectionSchemas.venues.safeParse(prepared);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual(["hotel.coords.lng"]);
  });

  it("gives a new wedding-party member a unique id from their name and keeps existing ids", () => {
    const party = [
      ...contentDefaults.party,
      { id: "", name: "Lilian", role: "Bridesmaid" },
      { id: "", name: "Ɔkyeame Ɛsi Bóakye", role: "Usher", lead: false },
      { id: "", name: "Lilian", role: "Flower girl" },
      { id: "", name: "!!", role: "Usher" },
    ];
    const prepared = prepareSection("party", party) as Record<string, unknown>[];

    expect(prepared.slice(0, contentDefaults.party.length)).toEqual(contentDefaults.party);
    expect(prepared.slice(contentDefaults.party.length).map((member) => member.id)).toEqual([
      "lilian-2",
      "okyeame-esi-boakye",
      "lilian-3",
      "member",
    ]);
    expect(prepared[contentDefaults.party.length + 1]).not.toHaveProperty("lead");
    expect(sectionSchemas.party.safeParse(prepared).success).toBe(true);
  });

  it("drops an empty travel link and makes an empty live-stream link null", () => {
    const travel = prepareSection("travel", [{ ...contentDefaults.travel[0], href: " " }]) as Record<string, unknown>[];
    expect(travel[0]).not.toHaveProperty("href");
    expect(prepareSection("liveStream", { url: "  " })).toEqual({ url: null });
    expect(prepareSection("liveStream", { url: " https://example.com/live " })).toEqual({
      url: "https://example.com/live",
    });
  });

  it("passes through what isn't the expected shape, for the schema to refuse", () => {
    expect(prepareSection("celebrations", "nope")).toBe("nope");
    expect(prepareSection("party", [null, 3])).toEqual([null, 3]);
    expect(prepareSection("venues", null)).toBeNull();
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
