import { describe, expect, it } from "vitest";
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
    value[0].place = "Victory Worship Centre\nTepa";
    value[0].dress = "Formal\r\nblack tie optional";
    expect(problems("celebrations", value)).toEqual([
      "celebrations[0].name: Use one line",
      "celebrations[0].time: Use one line",
      "celebrations[0].place: Use one line",
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
    const value = celebrations();
    value[0].directionsUrl = "https://maps.example.com/a b";
    expect(problems("celebrations", value)).toEqual(["celebrations[0].directionsUrl: Remove the space from the link"]);

    const venues = structuredClone(contentDefaults.venues);
    venues.church.mapsUrl = "https://maps.example.com/\nchurch";
    expect(problems("venues", venues)).toEqual(["venues.church.mapsUrl: Remove the space from the link"]);

    expect(problems("liveStream", { url: "https://live.example.com/our wedding" })).toEqual([
      "liveStream.url: Remove the space from the link",
    ]);
  });

  it("still ask for https when there is no space", () => {
    const value = celebrations();
    value[0].directionsUrl = "http://maps.example.com";
    expect(problems("celebrations", value)).toEqual([
      "celebrations[0].directionsUrl: Use an https:// link or an in-page anchor starting with #",
    ]);
    expect(problems("liveStream", { url: "http://live.example.com" })).toEqual([
      "liveStream.url: Use an https:// link, or leave it empty",
    ]);
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
