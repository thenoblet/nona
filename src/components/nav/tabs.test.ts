import { describe, expect, it } from "vitest";
import { activeTab, tabsFor } from "./tabs";

const summary = (mode: "before" | "day" | "after") => tabsFor(mode).map((tab) => `${tab.label} ${tab.href}${tab.hero ? " (hero)" : ""}`);

describe("tabsFor", () => {
  it("before the wedding: replying in the middle, and planning the trip around it", () => {
    expect(summary("before")).toEqual(["Home /home", "Programme /programme", "RSVP /rsvp (hero)", "Stay /stay", "Album /album"]);
  });

  it("on the day: sharing in the middle, with today's order, the album and the way there", () => {
    expect(summary("day")).toEqual(["Today /today", "Programme /programme", "Share /album#share (hero)", "Album /album", "Map /home#map"]);
  });

  it("after: reliving it in the middle, between home and the wishes", () => {
    expect(summary("after")).toEqual(["Home /home", "Relive /album (hero)", "Wishes /wishes"]);
  });

  it("puts the hero in the middle of every bar", () => {
    for (const mode of ["before", "day", "after"] as const) {
      const list = tabsFor(mode);
      expect(list.findIndex((tab) => tab.hero)).toBe((list.length - 1) / 2);
    }
  });
});

describe("activeTab", () => {
  it("marks the tab for the page the guest is on", () => {
    const before = tabsFor("before");
    expect(activeTab(before, "/home")).toBe("home");
    expect(activeTab(before, "/programme")).toBe("programme");
    expect(activeTab(before, "/rsvp")).toBe("rsvp");
    expect(activeTab(before, "/stay")).toBe("stay");
    expect(activeTab(before, "/album")).toBe("album");
    expect(activeTab(tabsFor("after"), "/wishes")).toBe("wishes");
    expect(activeTab(tabsFor("after"), "/album")).toBe("relive");
  });

  it("marks Album on the day's album, never Share or Map, which jump to a place on a page", () => {
    const day = tabsFor("day");
    expect(activeTab(day, "/album")).toBe("album");
    expect(activeTab(day, "/home")).toBeNull();
    expect(activeTab(day, "/today")).toBe("today");
  });

  it("marks nothing on a page without a tab, nor on one whose name only starts the same", () => {
    expect(activeTab(tabsFor("before"), "/wishes")).toBeNull();
    expect(activeTab(tabsFor("before"), "/homework")).toBeNull();
  });
});
