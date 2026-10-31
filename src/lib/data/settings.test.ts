import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { resetDb } from "../../../test/db";
import { getSetting, getSettings, SETTING_DEFAULTS, setSetting, type SettingKey } from "./settings";

beforeEach(resetDb);

describe("the settings' defaults", () => {
  it("keep uploads closed until the couple open them, and convert the backlog", () => {
    expect(SETTING_DEFAULTS).toEqual({
      uploads_open: false,
      uploads_closed_at: null,
      convert_backlog: true,
      worker_heartbeat: null,
    });
  });

  it("hold while nothing has been saved", async () => {
    for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
      expect(await getSetting(key, SETTING_DEFAULTS[key])).toBe(SETTING_DEFAULTS[key]);
    }
  });
});

describe("setSetting", () => {
  it("saves a value that getSetting then reads instead of the fallback", async () => {
    await setSetting("uploads_open", true);
    expect(await getSetting("uploads_open", SETTING_DEFAULTS.uploads_open)).toBe(true);
  });

  it("is typed by key, so a setting can't be saved or read as the wrong kind of value", () => {
    // Checked by tsc (npx tsc --noEmit), never run.
    async function misuses(): Promise<void> {
      // @ts-expect-error uploads_open is a boolean
      await setSetting("uploads_open", "yes");
      // @ts-expect-error uploads_open's fallback must be a boolean too
      await getSetting("uploads_open", "no");
      const closedAt: string | null = await getSetting("uploads_closed_at", null);
      // @ts-expect-error getSetting returns the key's own type
      const wrong: number = await getSetting("uploads_open", false);
      void [closedAt, wrong];
    }
    expect(misuses).toBeTypeOf("function");
  });

  it("replaces the saved value, keeping one row per key", async () => {
    await setSetting("uploads_closed_at", "2026-12-06T22:00:00.000Z");
    await setSetting("uploads_closed_at", "2026-12-07T09:30:00.000Z");
    expect(await getSetting("uploads_closed_at", SETTING_DEFAULTS.uploads_closed_at)).toBe("2026-12-07T09:30:00.000Z");
    const rows = await getDb().select().from(settings).where(eq(settings.key, "uploads_closed_at"));
    expect(rows).toHaveLength(1);
  });

  it("keeps a saved null, rather than falling back", async () => {
    await setSetting("uploads_closed_at", "2026-12-06T22:00:00.000Z");
    await setSetting("uploads_closed_at", null);
    expect(await getSetting("uploads_closed_at", "fallback")).toBeNull();
  });

  it("leaves the other settings as they were", async () => {
    await setSetting("convert_backlog", false);
    expect(await getSetting("uploads_open", SETTING_DEFAULTS.uploads_open)).toBe(false);
    expect(await getSetting("convert_backlog", SETTING_DEFAULTS.convert_backlog)).toBe(false);
  });

  it("stamps each save with the database's time", async () => {
    await setSetting("worker_heartbeat", "2026-12-05T18:00:00.000Z");
    await getDb().execute(sql`update settings set updated_at = now() - interval '1 hour'`);
    await setSetting("worker_heartbeat", "2026-12-05T19:00:00.000Z");
    const [row] = await getDb()
      .select({ fresh: sql<boolean>`${settings.updatedAt} > now() - interval '1 minute'` })
      .from(settings)
      .where(eq(settings.key, "worker_heartbeat"));
    expect(row.fresh).toBe(true);
  });
});

describe("getSettings", () => {
  it("reads several settings in one query, each its saved value or its fallback", async () => {
    const fallbacks = { uploads_open: false, uploads_closed_at: null };
    expect(await getSettings(fallbacks)).toEqual({ uploads_open: false, uploads_closed_at: null });
    await setSetting("uploads_closed_at", "2026-12-20T18:00:00.000Z");
    await setSetting("convert_backlog", false);
    expect(await getSettings(fallbacks)).toEqual({ uploads_open: false, uploads_closed_at: "2026-12-20T18:00:00.000Z" });
    await setSetting("uploads_open", true);
    expect(await getSettings({ uploads_open: false })).toEqual({ uploads_open: true });
  });
});
