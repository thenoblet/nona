import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../../../test/db";
import { dbConfig } from "@/lib/env";
import { contentDefaults } from "./defaults";
import { sectionKeys, sectionSchemas } from "./schema";
import { contentOrDefaults, listVersions, readSiteContent, restoreVersion, saveSection } from "./store";

const sql = postgres({ ...dbConfig(), max: 1 });
afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const faqA = [{ q: "Parking?", a: "Behind the church." }];
const faqB = [{ q: "Dress code?", a: "Formal." }];

describe("defaults", () => {
  it.each(sectionKeys)("%s passes its schema", (key) => {
    expect(sectionSchemas[key].safeParse(contentDefaults[key]).success).toBe(true);
  });

  it("dates the celebrations with no times", () => {
    expect(contentDefaults.celebrations.map((c) => [c.date, c.startTime, c.endTime])).toEqual([
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
    expect((await listVersions("faq")).map((v) => v.version)).toEqual([2, 1]);
  });

  it("restores an earlier version as a new one", async () => {
    await saveSection("faq", faqA, "test");
    await saveSection("faq", faqB, "test");
    expect(await restoreVersion("faq", 1, "test")).toEqual({ ok: true, version: 3 });
    expect((await readSiteContent()).faq).toEqual(faqA);
  });

  it("refuses to restore a version that does not exist", async () => {
    expect((await restoreVersion("faq", 9, "test")).ok).toBe(false);
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
      contentDefaults.schedule.filter((i) => i.day === "sat"),
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
    expect(stored.filter((f) => f.topic === "live-stream")).toHaveLength(1);
  });
});

describe("contentOrDefaults", () => {
  it("falls back to the defaults when the read fails", async () => {
    expect(await contentOrDefaults(() => Promise.reject(new Error("db down")))).toEqual(contentDefaults);
  });
});
