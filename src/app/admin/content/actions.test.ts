import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAt } from "@/components/admin/content/editing";
import { fieldsInOrder, sectionSpecs } from "@/components/admin/content/fields";
import { contentDefaults } from "@/lib/content/defaults";
import { listVersions, readSiteContent, saveSection } from "@/lib/content/store";
import { parseIssues, type SaveState } from "@/lib/admin/content";
import { saveSiteImage } from "@/lib/site-images/store";
import { resetDb } from "../../../../test/db";

const cache = vi.hoisted(() => ({ updateTag: vi.fn(), refresh: vi.fn() }));
vi.mock("next/cache", () => ({
  updateTag: cache.updateTag,
  refresh: cache.refresh,
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

const admin = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/admin/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/admin/access")>();
  return {
    ...real,
    requireAdmin: async () => {
      if (!admin.allowed) throw new real.AdminAccessError();
      return { email: "couple@example.com" };
    },
  };
});

import { restoreVersionAction, saveSectionAction } from "./actions";

const idle: SaveState = { status: "idle", errors: [] };

/** What the editor posts: the whole edited section as JSON, and the version it loaded. */
function editorForm(value: unknown, baseVersion = 0): FormData {
  const form = new FormData();
  form.set("value", JSON.stringify(value));
  form.set("baseVersion", String(baseVersion));
  return form;
}

beforeEach(async () => {
  await resetDb();
  admin.allowed = false;
  cache.updateTag.mockClear();
  cache.refresh.mockClear();
});

describe("without the couple", () => {
  it("both actions throw and nothing is saved", async () => {
    const celebrations = setAt(contentDefaults.celebrations, [0, "time"], "10:00 sharp");
    await expect(saveSectionAction("celebrations", idle, editorForm(celebrations))).rejects.toThrow(
      "Admin access refused",
    );
    await expect(restoreVersionAction("celebrations", 0, 0)).rejects.toThrow("Admin access refused");

    expect(await listVersions("celebrations")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("saveSectionAction", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  it("saves a valid celebrations form and updates the site's cache once", async () => {
    let celebrations = setAt(contentDefaults.celebrations, [0, "time"], "10:00 · please be seated early");
    celebrations = setAt(celebrations, [0, "startTime"], "10:00");
    celebrations = setAt(celebrations, [0, "endTime"], "12:30");

    expect(await saveSectionAction("celebrations", idle, editorForm(celebrations))).toEqual({
      status: "saved",
      errors: [],
      version: 1,
    });
    expect(cache.updateTag).toHaveBeenCalledOnce();
    expect(cache.updateTag).toHaveBeenCalledWith("site-content");
    expect(cache.refresh).toHaveBeenCalledOnce();

    const ceremony = (await readSiteContent()).celebrations[0];
    expect(ceremony).toMatchObject({ time: "10:00 · please be seated early", startTime: "10:00", endTime: "12:30" });
    expect((await listVersions("celebrations"))[0].savedBy).toBe("couple@example.com");
  });

  it("names the field when a start time is not a time, and changes nothing", async () => {
    const celebrations = setAt(contentDefaults.celebrations, [0, "startTime"], "25:00");

    const result = await saveSectionAction("celebrations", idle, editorForm(celebrations));
    expect(result.status).toBe("error");
    expect(result.errors).toContain("celebrations[0].startTime: Use a 24-hour time like 14:30");
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
    expect(await listVersions("celebrations")).toEqual([]);
    expect((await readSiteContent()).celebrations).toEqual(contentDefaults.celebrations);
  });

  it("refuses a GhanaPost GPS typed into a celebration's extra place note, on that field, and saves nothing", async () => {
    const celebrations = setAt(contentDefaults.celebrations, [1, "placeDetail"], "GhanaPost GPS · AX-1111-2222");

    const result = await saveSectionAction("celebrations", idle, editorForm(celebrations));
    expect(result).toEqual({
      status: "error",
      errors: ["celebrations[1].placeDetail: Put the GPS number in Venues → Reception → GhanaPost GPS"],
    });
    // The editor shows it on the reception's Extra place note.
    const [issue] = parseIssues("celebrations", result.errors);
    const field = fieldsInOrder(sectionSpecs.celebrations, celebrations).find((entry) => entry.path === issue.path);
    expect(field?.name).toBe("Reception · Extra place note");
    expect(await listVersions("celebrations")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
  });

  it("refuses an order of the day with no reception item left", async () => {
    const schedule = contentDefaults.schedule.filter((item) => item.celebration !== "reception");

    const result = await saveSectionAction("schedule", idle, editorForm(schedule));
    expect(result.status).toBe("error");
    expect(result.errors).toContain("schedule: Add at least one Reception item");
    expect(await listVersions("schedule")).toEqual([]);
  });

  it("keeps the live-stream topic on its question when the answers are edited", async () => {
    let faq: unknown = contentDefaults.faq;
    contentDefaults.faq.forEach((_item, index) => {
      faq = setAt(faq, [index, "answer"], `New answer ${index + 1}.`);
    });

    expect((await saveSectionAction("faq", idle, editorForm(faq))).status).toBe("saved");
    const saved = (await readSiteContent()).faq;
    expect(saved.map((item) => item.answer)).toEqual(contentDefaults.faq.map((_item, index) => `New answer ${index + 1}.`));
    expect(saved.filter((item) => item.topic === "live-stream")).toEqual([
      { question: "Can't make it in person?", answer: "New answer 5.", topic: "live-stream" },
    ]);
  });

  it("keeps a wedding-party member's id when they are renamed", async () => {
    const party = setAt(contentDefaults.party, [0, "name"], "Lily Mensah");

    expect((await saveSectionAction("party", idle, editorForm(party))).status).toBe("saved");
    expect((await readSiteContent()).party[0]).toEqual({ id: "lilian", name: "Lily Mensah", role: "Maid of honour", lead: true });
  });

  it("never gives a new member the id of a former member whose portrait is saved in Site photos (Task 19)", async () => {
    await saveSiteImage({ slot: "party-ama", mediaId: null, alt: "Ama, usher", focal: { x: 0.5, y: 0.4 }, savedBy: "a" });
    const party = [...contentDefaults.party, { id: "", name: "Ama", role: "Usher" }];

    expect((await saveSectionAction("party", idle, editorForm(party))).status).toBe("saved");
    expect((await readSiteContent()).party.at(-1)).toEqual({ id: "ama-2", name: "Ama", role: "Usher" });
  });

  it("works out the weekday, day and month from the date, whatever was posted", async () => {
    let celebrations = setAt(contentDefaults.celebrations, [1, "date"], "2026-12-07");
    celebrations = setAt(celebrations, [1, "weekday"], "Funday");
    celebrations = setAt(celebrations, [1, "day"], "99");

    expect((await saveSectionAction("celebrations", idle, editorForm(celebrations))).status).toBe("saved");
    expect((await readSiteContent()).celebrations[1]).toMatchObject({
      date: "2026-12-07",
      weekday: "Monday",
      weekdayShort: "Mon",
      day: "07",
      month: "December",
    });
  });

  it("refuses a save made from an older version, says who saved since and when, and saves nothing", async () => {
    const theirs = setAt(contentDefaults.faq, [0, "answer"], "Their answer.");
    expect(await saveSection("faq", theirs, "nancy@example.com")).toEqual({ ok: true, version: 1 });

    const mine = setAt(contentDefaults.faq, [0, "answer"], "My answer.");
    const result = await saveSectionAction("faq", idle, editorForm(mine, 0));
    expect(result.status).toBe("error");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(
      /^nancy@example\.com saved a newer version at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2}\. Reload to see it\.$/,
    );
    expect((await listVersions("faq")).map((entry) => entry.version)).toEqual([1]);
    expect((await readSiteContent()).faq[0].answer).toBe("Their answer.");
    expect(cache.updateTag).not.toHaveBeenCalled();

    // From the version it now shows, the same edit saves.
    expect(await saveSectionAction("faq", idle, editorForm(mine, 1))).toEqual({ status: "saved", errors: [], version: 2 });
  });

  it("says \"You\" when the newer version is the couple's own, from another tab", async () => {
    await saveSectionAction("faq", idle, editorForm(setAt(contentDefaults.faq, [0, "answer"], "First tab."), 0));
    const result = await saveSectionAction("faq", idle, editorForm(setAt(contentDefaults.faq, [0, "answer"], "Second tab."), 0));
    expect(result.errors[0]).toMatch(/^You saved a newer version at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2}\. Reload to see it\.$/);
  });

  it("refuses an unknown section, a form that isn't JSON, a missing version and an oversized form", async () => {
    const unknownSection = await saveSectionAction("nope" as never, idle, editorForm([]));
    expect(unknownSection.status).toBe("error");

    const notJson = new FormData();
    notJson.set("value", "{not json");
    notJson.set("baseVersion", "0");
    expect((await saveSectionAction("faq", idle, notJson)).status).toBe("error");

    const noVersion = new FormData();
    noVersion.set("value", JSON.stringify(contentDefaults.faq));
    expect((await saveSectionAction("faq", idle, noVersion)).status).toBe("error");

    const huge = [{ question: "Long?", answer: "x".repeat(256 * 1024) }];
    const tooBig = await saveSectionAction("faq", idle, editorForm(huge));
    expect(tooBig).toEqual({ status: "error", errors: [expect.stringContaining("too long")] });

    expect(await listVersions("faq")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
  });
});

describe("restoreVersionAction", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  const first = setAt(contentDefaults.faq, [0, "answer"], "First answer.");
  const second = setAt(contentDefaults.faq, [0, "answer"], "Second answer.");
  const third = setAt(contentDefaults.faq, [0, "answer"], "Third answer.");

  it("saves an earlier version again as a new version", async () => {
    await saveSectionAction("faq", idle, editorForm(first, 0));
    await saveSectionAction("faq", idle, editorForm(second, 1));
    cache.updateTag.mockClear();
    cache.refresh.mockClear();

    expect(await restoreVersionAction("faq", 1, 2)).toEqual({ status: "saved", errors: [], version: 3 });
    expect((await readSiteContent()).faq).toEqual(first);
    expect((await listVersions("faq")).map((entry) => entry.version)).toEqual([3, 2, 1]);
    expect(cache.updateTag).toHaveBeenCalledOnce();
    expect(cache.updateTag).toHaveBeenCalledWith("site-content");
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("restores the built-in text as a new version for version 0", async () => {
    await saveSectionAction("party", idle, editorForm(setAt(contentDefaults.party, [0, "name"], "Lily"), 0));

    expect(await restoreVersionAction("party", 0, 1)).toEqual({ status: "saved", errors: [], version: 2 });
    expect((await readSiteContent()).party).toEqual(contentDefaults.party);
    expect((await listVersions("party")).map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("refuses a restore from a page that hasn't seen the newest version, and changes nothing", async () => {
    // The page shows version 3 as live; Nancy then saves version 4 from her phone.
    await saveSectionAction("faq", idle, editorForm(first, 0));
    await saveSectionAction("faq", idle, editorForm(second, 1));
    await saveSectionAction("faq", idle, editorForm(third, 2));
    await saveSection("faq", setAt(contentDefaults.faq, [0, "answer"], "Nancy's fix."), "nancy@example.com");
    cache.updateTag.mockClear();
    cache.refresh.mockClear();

    for (const target of [1, 0]) {
      const result = await restoreVersionAction("faq", target, 3);
      expect(result.status).toBe("error");
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(
        /^nancy@example\.com saved a newer version at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2}\. Reload to see it\.$/,
      );
    }
    expect((await listVersions("faq")).map((entry) => entry.version)).toEqual([4, 3, 2, 1]);
    expect((await readSiteContent()).faq[0].answer).toBe("Nancy's fix.");
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();

    // From the version the page shows after a reload, the same restore goes through.
    expect(await restoreVersionAction("faq", 1, 4)).toEqual({ status: "saved", errors: [], version: 5 });
    expect((await readSiteContent()).faq).toEqual(first);
  });

  it("refuses a version that does not exist, an unknown section and numbers that aren't whole", async () => {
    expect((await restoreVersionAction("faq", 7, 0)).status).toBe("error");
    expect((await restoreVersionAction("nope" as never, 0, 0)).status).toBe("error");
    expect((await restoreVersionAction("faq", 1.5, 0)).status).toBe("error");
    expect((await restoreVersionAction("faq", -1, 0)).status).toBe("error");
    expect((await restoreVersionAction("faq", 0, -1)).status).toBe("error");
    expect((await restoreVersionAction("faq", 0, "1" as never)).status).toBe("error");
    expect(await listVersions("faq")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
  });
});
