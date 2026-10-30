import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDb } from "../../../test/db";
import { dbConfig } from "@/lib/env";
import { contentDefaults } from "./defaults";
import { readRsvpSettings } from "./rsvp";
import { listVersions, saveSection } from "./store";

const sql = postgres({ ...dbConfig(), max: 1 });
afterAll(() => sql.end());
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const open = contentDefaults.rsvp;
const closed = { ...contentDefaults.rsvp, open: false };

/** When and by whom a version was saved, as the store lists it. */
async function savedAs(version: number) {
  const entry = (await listVersions("rsvp")).find((listed) => listed.version === version);
  return { savedAt: entry?.savedAt, savedBy: entry?.savedBy };
}

describe("readRsvpSettings", () => {
  it("gives the built-in settings, open, as version 0 when nothing is saved", async () => {
    expect(await readRsvpSettings()).toEqual({ value: contentDefaults.rsvp, version: 0, closed: null });
  });

  it("names the version that closed replies, not a later save while they stayed closed", async () => {
    await saveSection("rsvp", closed, "nancy@example.com");
    await saveSection("rsvp", { ...closed, replyBy: "2026-11-25" }, "noblet@example.com");

    const settings = await readRsvpSettings();
    expect(settings.value).toEqual({ ...closed, replyBy: "2026-11-25" });
    expect(settings.version).toBe(2);
    expect(settings.closed).toEqual(await savedAs(1));
    expect(settings.closed?.savedBy).toBe("nancy@example.com");
  });

  it("names the latest close after a reopen, and nobody while open", async () => {
    await saveSection("rsvp", closed, "nancy@example.com");
    await saveSection("rsvp", open, "noblet@example.com");
    expect((await readRsvpSettings()).closed).toBeNull();

    await saveSection("rsvp", closed, "noblet@example.com");
    expect((await readRsvpSettings()).closed).toEqual(await savedAs(3));
  });

  it("falls back to the built-in settings, with the stored version, when the newest row has a bad shape", async () => {
    await saveSection("rsvp", closed, "nancy@example.com");
    await sql`insert into site_content (key, version, value, saved_by) values ('rsvp', 2, ${sql.json({ open: "no" })}, 'test')`;
    expect(await readRsvpSettings()).toEqual({ value: contentDefaults.rsvp, version: 2, closed: null });
  });
});
