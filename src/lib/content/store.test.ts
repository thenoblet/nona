import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../../../test/db";
import { celebrationsSavedBeforeVenues } from "../../../test/fixtures/saved-before-venues";
import { dbConfig } from "@/lib/env";
import { contentDefaults } from "./defaults";
import { sectionKeys, sectionSchemas } from "./schema";
import { contentOrDefaults, listVersions, readSection, readSiteContent, restoreVersion, saveSection } from "./store";

const sql = postgres({ ...dbConfig(), max: 1 });
afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const faqA = [{ question: "Parking?", answer: "Behind the church." }];
const faqB = [{ question: "Dress code?", answer: "Formal." }];

describe("defaults", () => {
  it.each(sectionKeys)("%s passes its schema", (key) => {
    expect(sectionSchemas[key].safeParse(contentDefaults[key]).success).toBe(true);
  });

  it("dates the celebrations with no times", () => {
    expect(contentDefaults.celebrations.map((celebration) => [celebration.date, celebration.startTime, celebration.endTime])).toEqual([
      ["2026-12-05", null, null],
      ["2026-12-05", null, null],
      ["2026-12-06", null, null],
    ]);
  });
});

describe("readSiteContent", () => {
  it("returns the defaults when nothing is saved", async () => {
    expect(await readSiteContent()).toEqual(contentDefaults);
  });

  it("merges a saved section over the defaults", async () => {
    expect(await saveSection("faq", faqA, "test")).toEqual({ ok: true, version: 1 });
    const content = await readSiteContent();
    expect(content.faq).toEqual(faqA);
    expect(content.travel).toEqual(contentDefaults.travel);
    expect(content.celebrations).toEqual(contentDefaults.celebrations);
  });

  it("reads celebrations saved before each named its venue, rather than falling back to the built-in text", async () => {
    // As production saved them, with a dress code the built-in text doesn't have, to tell the two apart.
    const saved = structuredClone(celebrationsSavedBeforeVenues);
    saved[1].dress = "Evening glamour, as saved";
    await sql`insert into site_content (key, version, value, saved_by) values ('celebrations', 3, ${sql.json(saved)}, 'test')`;
    const { celebrations } = await readSiteContent();
    expect(console.error).not.toHaveBeenCalled();
    expect(celebrations.map((celebration) => [celebration.id, celebration.venue, celebration.placeDetail])).toEqual([
      ["ceremony", "church", undefined],
      ["reception", "reception", undefined],
      ["thanks", "church", undefined],
    ]);
    expect(celebrations[1].dress).toBe("Evening glamour, as saved");
    const section = await readSection("celebrations");
    expect(section.version).toBe(3);
    expect(section.value).toEqual(celebrations);
  });

  it("falls back to the default for a stored row with a bad shape", async () => {
    await sql`insert into site_content (key, version, value, saved_by) values ('faq', 1, ${sql.json({ nope: 1 })}, 'test')`;
    const content = await readSiteContent();
    expect(content.faq).toEqual(contentDefaults.faq);
    expect(console.error).toHaveBeenCalled();
  });
});

describe("versions", () => {
  it("numbers saves and lists newest first", async () => {
    await saveSection("faq", faqA, "test");
    expect(await saveSection("faq", faqB, "test")).toEqual({ ok: true, version: 2 });
    expect((await listVersions("faq")).map((entry) => entry.version)).toEqual([2, 1]);
  });

  it("restores an earlier version as a new one", async () => {
    await saveSection("faq", faqA, "test");
    await saveSection("faq", faqB, "test");
    expect(await restoreVersion("faq", 1, "test")).toEqual({ ok: true, version: 3 });
    expect((await readSiteContent()).faq).toEqual(faqA);
  });

  it("restores a version saved before the celebrations named their venues, in the new shape", async () => {
    await sql`insert into site_content (key, version, value, saved_by) values ('celebrations', 1, ${sql.json(celebrationsSavedBeforeVenues)}, 'test')`;
    expect(await saveSection("celebrations", contentDefaults.celebrations, "test")).toEqual({ ok: true, version: 2 });
    expect(await restoreVersion("celebrations", 1, "test")).toEqual({ ok: true, version: 3 });

    const [restored] = await sql<{ value: Record<string, unknown>[] }[]>`
      select value from site_content where key = 'celebrations' and version = 3`;
    expect(restored.value.map((celebration) => [celebration.id, celebration.venue])).toEqual([
      ["ceremony", "church"],
      ["reception", "reception"],
      ["thanks", "church"],
    ]);
    for (const celebration of restored.value) {
      expect(celebration).not.toHaveProperty("place");
      expect(celebration).not.toHaveProperty("directionsUrl");
      expect(celebration).not.toHaveProperty("placeDetail");
    }
  });

  it("refuses to restore a version that does not exist", async () => {
    expect((await restoreVersion("faq", 9, "test")).ok).toBe(false);
  });
});

describe("saving from a loaded version", () => {
  it("saves when the loaded version is still the newest, including none saved yet", async () => {
    expect(await saveSection("faq", faqA, "test", { baseVersion: 0 })).toEqual({ ok: true, version: 1 });
    expect(await saveSection("faq", faqB, "test", { baseVersion: 1 })).toEqual({ ok: true, version: 2 });
  });

  it("refuses when someone saved since, says who and when, and saves nothing", async () => {
    await saveSection("faq", faqA, "nancy@example.com");
    const result = await saveSection("faq", faqB, "noblet@example.com", { baseVersion: 0 });
    expect(result).toEqual({
      ok: false,
      errors: [expect.any(String)],
      newer: { version: 1, savedBy: "nancy@example.com", savedAt: expect.any(Date) },
    });
    expect((await listVersions("faq")).map((entry) => entry.version)).toEqual([1]);
  });

  it("lets only one of two saves from the same version through", async () => {
    const results = await Promise.all([
      saveSection("faq", faqA, "nancy@example.com", { baseVersion: 0 }),
      saveSection("faq", faqB, "noblet@example.com", { baseVersion: 0 }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(await listVersions("faq")).toHaveLength(1);
  });
});

describe("readSection", () => {
  it("gives the built-in text as version 0 when nothing is saved", async () => {
    expect(await readSection("faq")).toEqual({ value: contentDefaults.faq, version: 0 });
  });

  it("gives the newest saved value with its version", async () => {
    await saveSection("faq", faqA, "test");
    await saveSection("faq", faqB, "test");
    expect(await readSection("faq")).toEqual({ value: faqB, version: 2 });
  });

  it("gives the built-in text, with the stored version, when the newest row has a bad shape", async () => {
    await sql`insert into site_content (key, version, value, saved_by) values ('faq', 4, ${sql.json({ nope: 1 })}, 'test')`;
    expect(await readSection("faq")).toEqual({ value: contentDefaults.faq, version: 4 });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("validation", () => {
  const celebrations = () => structuredClone(contentDefaults.celebrations);

  async function expectRejected(key: Parameters<typeof saveSection>[0], value: unknown, message?: string) {
    const result = await saveSection(key, value, "test");
    expect(result.ok).toBe(false);
    if (message && !result.ok) expect(result.errors.join("\n")).toContain(message);
    expect(await listVersions(key)).toEqual([]);
  }

  it("rejects an empty celebration name", async () => {
    const value = celebrations();
    value[0].name = "";
    await expectRejected("celebrations", value, "celebrations[0].name");
  });

  it("rejects celebrations that repeat an id", async () => {
    const value = celebrations().map((celebration) => ({ ...celebration, id: "ceremony" }));
    await expectRejected("celebrations", value, "celebrations: Keep the white wedding, reception and thanksgiving, each once");
  });

  it("rejects a bad start time with a readable message", async () => {
    const value = celebrations();
    value[0].startTime = "25:00";
    await expectRejected("celebrations", value, "celebrations[0].startTime: Use a 24-hour time like 14:30");
  });

  it("rejects a live-stream link that is not a URL", async () => {
    await expectRejected("liveStream", { url: "not a url" }, "url");
  });

  it("rejects a schedule with no Sunday item", async () => {
    await expectRejected(
      "schedule",
      contentDefaults.schedule.filter((item) => item.day === "sat"),
      "Sunday",
    );
  });

  it("accepts an https live-stream link and null", async () => {
    expect((await saveSection("liveStream", { url: "https://example.com/live" }, "test")).ok).toBe(true);
    expect((await saveSection("liveStream", { url: null }, "test")).ok).toBe(true);
  });

  it("keeps topic on the live-stream FAQ item", async () => {
    await saveSection("faq", contentDefaults.faq, "test");
    const stored = (await readSiteContent()).faq;
    expect(stored.filter((item) => item.topic === "live-stream")).toHaveLength(1);
  });
});

describe("contentOrDefaults", () => {
  afterEach(async () => {
    // Let any fallback window run out, then read once, so no later test is handed the defaults.
    if (vi.isFakeTimers()) vi.advanceTimersByTime(30_000);
    await contentOrDefaults(() => Promise.resolve(contentDefaults));
    vi.useRealTimers();
  });

  it("falls back to the defaults when the read fails, and keeps them for 30 s without trying again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const failing = vi.fn(() => Promise.reject(new Error("db down")));
    expect(await contentOrDefaults(failing)).toEqual(contentDefaults);
    expect(failing).toHaveBeenCalledOnce();

    // During an outage each page would otherwise wait out the 5 s connect timeout.
    vi.advanceTimersByTime(29_000);
    expect(await contentOrDefaults(failing)).toEqual(contentDefaults);
    expect(failing).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1_000);
    expect(await contentOrDefaults(failing)).toEqual(contentDefaults);
    expect(failing).toHaveBeenCalledTimes(2);

    // After 30 s more, the first read that works replaces the fallback, and the next read runs too.
    vi.advanceTimersByTime(30_000);
    const saved = { ...contentDefaults, landmarks: ["Saved landmark"] };
    const working = vi.fn(() => Promise.resolve(saved));
    expect(await contentOrDefaults(working)).toEqual(saved);
    expect(await contentOrDefaults(working)).toEqual(saved);
    expect(working).toHaveBeenCalledTimes(2);
  });

  it("leaves no fallback behind once a read works again, whatever the clock does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await contentOrDefaults(() => Promise.reject(new Error("db down")));
    vi.advanceTimersByTime(30_000);
    await contentOrDefaults(() => Promise.resolve(contentDefaults));
    // Back on the real clock, which is behind the fake one, the next read still runs.
    vi.useRealTimers();
    const working = vi.fn(() => Promise.resolve(contentDefaults));
    await contentOrDefaults(working);
    expect(working).toHaveBeenCalledOnce();
  });
});
