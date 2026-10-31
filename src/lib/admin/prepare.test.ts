import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { sectionSchemas } from "@/lib/content/schema";
import { prepareSection } from "./prepare";

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

  it("leaves out the venue of an order of the day item set to Other place, keeping its typed place", () => {
    const [atChurch, otherPlace] = prepareSection("schedule", [
      { ...contentDefaults.schedule[0], venue: "church" },
      { time: "[Time]", title: "After-party", venue: "", place: "Rexco Junction", day: "sat" },
    ]) as Record<string, unknown>[];
    expect(atChurch.venue).toBe("church");
    expect(otherPlace).toEqual({ time: "[Time]", title: "After-party", place: "Rexco Junction", day: "sat" });
  });

  it("trims the maps links", () => {
    const venues = prepareSection("venues", {
      ...contentDefaults.venues,
      hotel: { ...contentDefaults.venues.hotel, mapsUrl: " https://maps.example.com/hotel " },
    }) as Record<string, Record<string, unknown>>;
    expect(venues.hotel.mapsUrl).toBe("https://maps.example.com/hotel");
  });

  it("never gives a new member an id the built-in list or a portrait already uses", () => {
    // Lilian and James have portraits; with both gone from the list, a new Lilian or James still
    // must not pick up their photos.
    const party = [
      { id: "bernice", name: "Bernice", role: "Bridesmaid" },
      { id: "", name: "Lilian", role: "Usher" },
      { id: "", name: "James", role: "Usher" },
      { id: "", name: "Dennis", role: "Usher" },
    ];
    const prepared = prepareSection("party", party) as Record<string, unknown>[];
    expect(prepared.map((member) => member.id)).toEqual(["bernice", "lilian-2", "james-2", "dennis-2"]);
  });

  it("passes through what isn't the expected shape, for the schema to refuse", () => {
    expect(prepareSection("celebrations", "nope")).toBe("nope");
    expect(prepareSection("party", [null, 3])).toEqual([null, 3]);
    expect(prepareSection("venues", null)).toBeNull();
  });
});
