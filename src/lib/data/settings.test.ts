import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import { resetDb } from "../../../test/db";
import { getSetting, SETTING_DEFAULTS, setSetting, type SettingKey } from "./settings";

beforeEach(resetDb);

describe("the settings' defaults", () => {
  it("open uploads and the backlog conversions, with no close time and no worker heartbeat yet", () => {
    expect(SETTING_DEFAULTS).toEqual({
      uploads_open: true,
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
    await setSetting("uploads_open", false);
    expect(await getSetting("uploads_open", SETTING_DEFAULTS.uploads_open)).toBe(false);
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
    expect(await getSetting("uploads_open", SETTING_DEFAULTS.uploads_open)).toBe(true);
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
