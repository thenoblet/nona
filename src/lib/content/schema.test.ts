import { describe, expect, it } from "vitest";
import { celebrationsSavedBeforeVenues } from "../../../test/fixtures/saved-celebrations";
import { contentDefaults } from "./defaults";
import { formatIssues, sectionKeys, sectionSchemas, type SectionKey } from "./schema";

function problems(key: SectionKey, value: unknown): string[] {
  const result = sectionSchemas[key].safeParse(value);
  return result.success ? [] : formatIssues(result.error, key);
}

const celebrations = () => structuredClone(contentDefaults.celebrations);

describe("the built-in text", () => {
  it.each(sectionKeys)("%s still passes its schema", (key) => {
    expect(problems(key, contentDefaults[key])).toEqual([]);
  });
});

describe("one-line fields", () => {
  it("refuse a line break in names, titles, roles, times, places and dress codes", () => {
    const value = celebrations();
    value[0].name = "White\nwedding";
    value[0].time = "10:00\nplease be seated early";
    value[0].placeDetail = "Main hall\nupstairs";
    value[0].dress = "Formal\r\nblack tie optional";
    expect(problems("celebrations", value)).toEqual([
      "celebrations[0].name: Use one line",
      "celebrations[0].time: Use one line",
      "celebrations[0].placeDetail: Use one line",
      "celebrations[0].dress: Use one line",
    ]);

    const schedule = structuredClone(contentDefaults.schedule);
    schedule[0].title = "Guests\narrive";
    expect(problems("schedule", schedule)).toEqual(["schedule[0].title: Use one line"]);

    const party = structuredClone(contentDefaults.party);
    party[0].role = "Maid\nof honour";
    expect(problems("party", party)).toEqual(["party[0].role: Use one line"]);

    expect(problems("faq", [{ question: "Parking?\nWhere?", answer: "Behind the church." }])).toEqual([
      "faq[0].question: Use one line",
    ]);
  });

  it("leave answers and story texts free to run over several lines", () => {
    expect(problems("faq", [{ question: "Parking?", answer: "Behind the church.\nOr at the school." }])).toEqual([]);
    const story = structuredClone(contentDefaults.story);
    story.met.text = "First year.\nShe was the most collected.";
    story.asked.quote = "Will you\nmarry me?";
    expect(problems("story", story)).toEqual([]);
  });

  it("trim surrounding space and line breaks before checking", () => {
    const value = celebrations();
    value[0].name = "  White wedding\n";
    expect(sectionSchemas.celebrations.parse(value)[0].name).toBe("White wedding");
  });
});

describe("links", () => {
  it("say to remove a space rather than asking for https", () => {
    const venues = structuredClone(contentDefaults.venues);
    venues.church.mapsUrl = "https://maps.example.com/\nchurch";
    expect(problems("venues", venues)).toEqual(["venues.church.mapsUrl: Remove the space from the link"]);

    expect(problems("liveStream", { url: "https://live.example.com/our wedding" })).toEqual([
      "liveStream.url: Remove the space from the link",
    ]);
  });

  it("still ask for https when there is no space", () => {
    const venues = structuredClone(contentDefaults.venues);
    venues.reception.mapsUrl = "http://maps.example.com";
    expect(problems("venues", venues)).toEqual([
      "venues.reception.mapsUrl: Use an https:// link or an in-page anchor starting with #",
    ]);
    expect(problems("liveStream", { url: "http://live.example.com" })).toEqual([
      "liveStream.url: Use an https:// link, or leave it empty",
    ]);
  });
});

describe("celebration venues", () => {
  it("put the white wedding and the thanksgiving at the church and the reception at the reception venue", () => {
    expect(contentDefaults.celebrations.map((celebration) => [celebration.id, celebration.venue])).toEqual([
      ["ceremony", "church"],
      ["reception", "reception"],
      ["thanks", "church"],
    ]);
  });

  it("keep the venue a celebration names, and refuse one that holds no celebration", () => {
    const value = celebrations();
    value[2].venue = "reception";
    expect(sectionSchemas.celebrations.parse(value)[2].venue).toBe("reception");

    (value[0] as { venue: string }).venue = "hotel";
    expect(problems("celebrations", value)).toEqual(["celebrations[0].venue: Choose the church or the reception venue"]);
  });

  it("give the reception venue the GhanaPost GPS Noblet entered, as the built-in text", () => {
    expect(contentDefaults.venues.reception.gps).toBe("AX-0084-3317");
  });
});

describe("celebrations saved before each named its venue", () => {
  const savedBeforeVenues = () => structuredClone(celebrationsSavedBeforeVenues);

  it("still parse, each at the venue its id implies", () => {
    const parsed = sectionSchemas.celebrations.safeParse(savedBeforeVenues());
    expect(parsed.error).toBeUndefined();
    expect(parsed.data?.map((celebration) => [celebration.id, celebration.venue])).toEqual([
      ["ceremony", "church"],
      ["reception", "reception"],
      ["thanks", "church"],
    ]);
  });

  it("lose their own place and directions link, and a place detail that is only the GhanaPost GPS", () => {
    const parsed = sectionSchemas.celebrations.parse(savedBeforeVenues());
    for (const celebration of parsed) {
      expect(celebration).not.toHaveProperty("place");
      expect(celebration).not.toHaveProperty("directionsUrl");
      expect(celebration).not.toHaveProperty("placeDetail");
    }
    // Everything else is read as it was saved.
    expect(parsed[1]).toEqual({
      id: "reception",
      venue: "reception",
      name: "Reception",
      weekday: "Saturday",
      weekdayShort: "Sat",
      day: "05",
      month: "December",
      time: "Right after the white wedding · dinner & dancing",
      dress: "Evening glamour",
      date: "2026-12-05",
      startTime: null,
      endTime: null,
    });
  });

  it("drop a GhanaPost GPS detail however it is written, and keep any other note", () => {
    const value = savedBeforeVenues();
    Object.assign(value[0], { placeDetail: "  ghanapost gps: AS-0000-0001" });
    Object.assign(value[2], { placeDetail: "Main hall, upstairs" });
    const parsed = sectionSchemas.celebrations.parse(value);
    expect(parsed[0]).not.toHaveProperty("placeDetail");
    expect(parsed[2].placeDetail).toBe("Main hall, upstairs");
  });
});

describe("celebration times", () => {
  it("refuse an end at the start, on the end time", () => {
    const value = celebrations();
    value[1].startTime = "15:00";
    value[1].endTime = "15:00";
    expect(problems("celebrations", value)).toEqual(["celebrations[1].endTime: Ends must be after Starts"]);
  });

  it("read an end before the start as after midnight", () => {
    const value = celebrations();
    value[1].startTime = "18:00";
    value[1].endTime = "02:00";
    expect(problems("celebrations", value)).toEqual([]);
  });

  it("accept an end after the start, and either time alone", () => {
    const value = celebrations();
    value[0].startTime = "10:00";
    value[0].endTime = "12:30";
    value[1].startTime = "14:00";
    value[2].endTime = "11:00";
    expect(problems("celebrations", value)).toEqual([]);
  });

  it("give a malformed time only its own message", () => {
    const value = celebrations();
    value[0].startTime = "25:00";
    value[0].endTime = "11:00";
    expect(problems("celebrations", value)).toEqual(["celebrations[0].startTime: Use a 24-hour time like 14:30"]);
  });
});

describe("wedding party ids", () => {
  it("must differ, so no two people share a portrait", () => {
    const party = [...structuredClone(contentDefaults.party), { id: "lilian", name: "Lilian Owusu", role: "Usher" }];
    expect(problems("party", party)).toEqual([`party[${party.length - 1}].id: Each person needs a different id`]);
  });

  it("are checked without throwing when a member isn't one", () => {
    expect(problems("party", [null, { id: "james", name: "James", role: "Best man" }])).toEqual([
      "party[0]: Invalid input: expected object, received null",
    ]);
  });
});

describe("RSVP settings", () => {
  const settings = () => structuredClone(contentDefaults.rsvp);

  it("refuse a reply-by date on or after the wedding", () => {
    expect(problems("rsvp", { ...settings(), replyBy: "2026-12-05" })).toEqual(["rsvp.replyBy: Use a date before the wedding"]);
    expect(problems("rsvp", { ...settings(), replyBy: "2027-01-10" })).toEqual(["rsvp.replyBy: Use a date before the wedding"]);
    expect(problems("rsvp", { ...settings(), replyBy: "2026-12-04" })).toEqual([]);
  });

  it("refuse a reply-by date that is not a real one, with only its own message", () => {
    expect(problems("rsvp", { ...settings(), replyBy: "2026-11-31" })).toEqual(["rsvp.replyBy: Not a real date"]);
    expect(problems("rsvp", { ...settings(), replyBy: "20 November" })).not.toContain("rsvp.replyBy: Use a date before the wedding");
    expect(problems("rsvp", { ...settings(), replyBy: "20 November" })).toContain("rsvp.replyBy: Use a date like 2026-12-05");
  });

  it("refuse an empty closed message, and one over 300 characters", () => {
    expect(problems("rsvp", { ...settings(), closedMessage: "" })).toEqual(["rsvp.closedMessage: Cannot be empty"]);
    expect(problems("rsvp", { ...settings(), closedMessage: "  \n " })).toEqual(["rsvp.closedMessage: Cannot be empty"]);
    expect(problems("rsvp", { ...settings(), closedMessage: "a".repeat(301) })).toEqual([
      "rsvp.closedMessage: Use at most 300 characters",
    ]);
    expect(problems("rsvp", { ...settings(), closedMessage: "a".repeat(300) })).toEqual([]);
  });

  it("start open, asking for replies by 20 November", () => {
    expect(contentDefaults.rsvp).toEqual({
      open: true,
      replyBy: "2026-11-20",
      closedMessage:
        "Replies are now closed. Thank you to everyone who let us know! If your plans have changed, please message Noblet or Nancy directly.",
    });
  });
});
