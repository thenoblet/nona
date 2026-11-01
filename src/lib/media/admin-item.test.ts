import { describe, expect, it } from "vitest";
import {
  adminFilterQuery,
  badgeOf,
  failureReasonWords,
  fileWords,
  lockWords,
  parseAdminFilter,
  statusWords,
  tileTimeWords,
  type AdminItem,
} from "./admin-item";

const base: AdminItem = {
  id: "8c0b3f2e-1f8c-4d0a-9a51-2f0f8d6f3c11",
  kind: "photo",
  state: null,
  by: "Ama Owusu",
  uploads: 9,
  celebration: "reception",
  uploadedAt: "2026-12-05T19:30:00.000Z",
  takenAt: "2026-12-05T19:29:00.000Z",
  hiddenAt: null,
  hiddenBy: null,
  highlight: false,
  width: 3024,
  height: 4032,
  seconds: null,
  thumbhash: null,
  color: null,
  thumb: null,
  view: null,
  failure: null,
  original: { type: "HEIC", bytes: 2_100_000, heic: true },
  deletableFrom: "2027-01-04T20:30:00.000Z",
  deletable: false,
};

describe("the admin's filter", () => {
  it("reads the chip, celebration, kind and search the page's address names, and writes them back", () => {
    const query = new URLSearchParams("show=failed&celebration=more&kind=video&q=%20Ama%20");
    const filter = parseAdminFilter(query);
    expect(filter).toEqual({ chip: "failed", celebration: "more", kind: "video", search: "Ama" });
    expect(adminFilterQuery(filter!).toString()).toBe("show=failed&celebration=more&kind=video&q=Ama");
    expect(parseAdminFilter(new URLSearchParams(""))).toEqual({});
    expect(parseAdminFilter(new URLSearchParams("q=%20%20"))).toEqual({});
  });

  it("refuses a chip, celebration or kind the admin doesn't offer, and a search past 80 characters", () => {
    for (const query of ["show=all", "show=deleted", "celebration=honeymoon", "kind=audio", `q=${"a".repeat(81)}`]) {
      expect(parseAdminFilter(new URLSearchParams(query)), query).toBeNull();
    }
  });
});

describe("the admin's words", () => {
  it("badges each state as gate B does, the tile shorter where it must be", () => {
    expect(badgeOf({ ...base, state: "removed" })).toEqual({ tone: "none", panel: "Removed by guest", tile: "Removed" });
    expect(badgeOf({ ...base, state: "hidden" })).toEqual({ tone: "none", panel: "Hidden", tile: "Hidden" });
    expect(badgeOf({ ...base, state: "failed" })).toEqual({ tone: "bad", panel: "Failed", tile: "Failed" });
    expect(badgeOf({ ...base, state: "processing" })).toEqual({ tone: "wait", panel: "Processing", tile: "Processing" });
    expect(badgeOf({ ...base, state: "converting" })).toEqual({ tone: "wait", panel: "Converting", tile: "Converting" });
    expect(badgeOf({ ...base, state: "queued" })).toEqual({ tone: "wait", panel: "Waiting to convert", tile: "Queued" });
    expect(badgeOf(base)).toBeNull();
  });

  it("says who hid an item and when, and what guests see otherwise", () => {
    expect(statusWords({ ...base, state: "hidden", hiddenAt: "2026-12-05T18:30:00.000Z", hiddenBy: "nancy@example.com" })).toBe(
      "Hidden by nancy@example.com, 5 Dec, 18:30. Guests can't see it.",
    );
    expect(statusWords({ ...base, state: "removed", hiddenAt: "2026-12-05T19:41:00.000Z", hiddenBy: "guest" })).toBe(
      "Ama Owusu removed it at 5 Dec, 19:41. Guests can't see it.",
    );
    expect(statusWords(base)).toBe("Guests can see it.");
    expect(statusWords({ ...base, state: "processing" })).toBe("Making the thumbnail and viewing size. Guests see it in a moment.");
    expect(statusWords({ ...base, state: "failed", failure: { during: "processing", reason: "corrupt" } })).toBe(
      "Guests can't see it until it's processed.",
    );
    expect(statusWords({ ...base, kind: "video", state: "failed", failure: { during: "conversion", reason: "too-slow" } })).toBe(
      "Guests can see its poster, but phones that can't play the original have no version to play.",
    );
  });

  it("puts a worker's reason in plain words", () => {
    expect(failureReasonWords({ during: "processing", reason: "corrupt" }, "video")).toBe("The file is damaged or cut short, so it couldn't be read.");
    expect(failureReasonWords({ during: "processing", reason: "unsupported-type" }, "photo")).toBe("This photo's format can't be read.");
    expect(failureReasonWords({ during: "conversion", reason: "too-slow" }, "video")).toBe("Converting it for phones took too long, three times in a row.");
    expect(failureReasonWords({ during: "processing", reason: null }, "photo")).toBe("Processing it failed after several tries.");
  });

  it("describes the original, and when it may be deleted", () => {
    expect(fileWords(base)).toBe("HEIC · 2.0 MB · 3024 × 4032");
    expect(fileWords({ ...base, width: null, height: null, original: { type: "MOV", bytes: 12_000_000, heic: false } })).toBe("MOV · 11.4 MB");
    expect(lockWords("2027-01-04T20:30:00.000Z")).toBe("4 Jan, 20:30");
    expect(tileTimeWords("2026-12-05T22:04:00.000Z")).toBe("Sat 22:04");
  });
});
