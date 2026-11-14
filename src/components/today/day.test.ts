import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import type { Celebration, ScheduleItem } from "@/lib/content/schema";
import { currentItem, inProgrammeOrder, itemStarts, programmeNow, stateOf } from "./day";

// The built-in celebrations, without the end times the built-in text sets, so each item's own limits show.
const celebrations: Celebration[] = structuredClone(contentDefaults.celebrations).map((celebration) => ({
  ...celebration,
  startTime: null,
  endTime: null,
}));

/** A moment in Tepa (GMT, so UTC) on the wedding weekend. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00Z`);
const saturday = (time: string) => at("2026-12-05", time);
const sunday = (time: string) => at("2026-12-06", time);

const programme: ScheduleItem[] = [
  { celebration: "ceremony", title: "Guests arrive", time: "09:30" },
  { celebration: "ceremony", title: "Processional", time: "10:00" },
  { celebration: "ceremony", title: "Opening hymn" },
  { celebration: "ceremony", title: "Vows", time: "10:30" },
  { celebration: "reception", title: "Grand entrance", time: "15:00" },
  { celebration: "reception", title: "Dancing", time: "21:00" },
  { celebration: "reception", title: "Last song", time: "00:30" },
];

const titleAt = (now: Date, schedule = programme, withCelebrations = celebrations) =>
  currentItem(schedule, withCelebrations, now)?.title;

describe("programmeNow", () => {
  it("has nothing on before the first item starts", () => {
    expect(programmeNow(programme, celebrations, saturday("09:00"))).toEqual({ current: -1, started: -1 });
  });

  it("marks the last item whose time has passed", () => {
    expect(titleAt(saturday("09:30"))).toBe("Guests arrive");
    expect(titleAt(saturday("10:15"))).toBe("Processional");
    expect(titleAt(saturday("15:10"))).toBe("Grand entrance");
  });

  it("never marks an item without a time, but reads it as done once a later item starts", () => {
    const standing = programmeNow(programme, celebrations, saturday("11:15"));
    expect(programme[standing.current].title).toBe("Vows");
    expect(stateOf(2, standing)).toBe("done");
    expect(stateOf(4, standing)).toBe("next");
  });

  it("reads an earlier reception time as after midnight", () => {
    expect(titleAt(saturday("23:50"))).toBe("Dancing");
    expect(titleAt(sunday("00:40"))).toBe("Last song");
    expect(itemStarts(programme, celebrations)[6]).toBe(sunday("00:30").getTime());
  });

  it("lets an item go after four hours when nothing after it has started", () => {
    expect(titleAt(saturday("14:31"))).toBeUndefined();
    const standing = programmeNow(programme, celebrations, saturday("14:31"));
    expect(stateOf(3, standing)).toBe("done");
  });

  it("ends with its celebration when the celebration's end time is set", () => {
    const ending = celebrations.map((celebration) =>
      celebration.id === "ceremony" ? { ...celebration, startTime: "09:30", endTime: "12:00" } : celebration,
    );
    expect(titleAt(saturday("11:55"), programme, ending)).toBe("Vows");
    expect(titleAt(saturday("12:05"), programme, ending)).toBeUndefined();
  });

  it("follows a celebration's date when the couple change it", () => {
    const moved = celebrations.map((celebration) =>
      celebration.id === "reception" ? { ...celebration, date: "2026-12-12" } : celebration,
    );
    expect(titleAt(saturday("15:10"), programme, moved)).toBeUndefined();
    expect(titleAt(at("2026-12-12", "15:10"), programme, moved)).toBe("Grand entrance");
  });

  it("has nothing on for a programme with no times, or none at all", () => {
    const untimed = contentDefaults.schedule.map((item) => ({ ...item, time: undefined }));
    expect(titleAt(saturday("12:00"), untimed)).toBeUndefined();
    expect(programmeNow([], celebrations, saturday("12:00"))).toEqual({ current: -1, started: -1 });
  });
});

describe("the built-in programme", () => {
  it("follows the day by the clock", () => {
    const builtIn = (now: Date) => currentItem(contentDefaults.schedule, contentDefaults.celebrations, now)?.title;
    expect(builtIn(saturday("07:00"))).toBeUndefined();
    expect(builtIn(saturday("09:20"))).toBe("Exchange of vows");
    expect(builtIn(saturday("13:40"))).toBe("First dance");
    // The reception ends at 5:30 PM.
    expect(builtIn(saturday("17:29"))).toBe("Closing remarks and appreciation");
    expect(builtIn(saturday("17:31"))).toBeUndefined();
  });
});

describe("inProgrammeOrder", () => {
  it("groups the items by celebration, each keeping its own order", () => {
    const mixed: ScheduleItem[] = [
      { celebration: "reception", title: "Toast" },
      { celebration: "ceremony", title: "Arrive" },
      { celebration: "reception", title: "Dinner" },
      { celebration: "ceremony", title: "Vows" },
    ];
    expect(inProgrammeOrder(mixed).map((item) => item.title)).toEqual(["Arrive", "Vows", "Toast", "Dinner"]);
  });
});
