import "server-only";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";

/** The switches and markers the app and the worker share, each one JSON value in `settings`. */
export type SettingValues = {
  /**
   * Whether guests may start album uploads. Closed until the couple open them (the migration
   * saves false too), so no deploy opens uploads before the admin switch and the bucket lock exist.
   */
  uploads_open: boolean;
  /** When uploads were last closed (ISO time); resumes are allowed for 24 h after it. */
  uploads_closed_at: string | null;
  /** Whether the worker converts the backlog of videos no phone has asked for yet. */
  convert_backlog: boolean;
  /** The worker's last heartbeat (ISO time), or null before it has ever run. */
  worker_heartbeat: string | null;
};

export type SettingKey = keyof SettingValues;

/** Each setting's value until one is saved. Pass it as getSetting's fallback. */
export const SETTING_DEFAULTS: SettingValues = {
  uploads_open: false,
  uploads_closed_at: null,
  convert_backlog: true,
  worker_heartbeat: null,
};

/** The setting's saved value, or `fallback` when none has been saved. A saved null stays null. */
export async function getSetting<TKey extends SettingKey>(
  key: TKey,
  fallback: SettingValues[TKey],
): Promise<SettingValues[TKey]> {
  const [row] = await getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
  return row ? (row.value as SettingValues[TKey]) : fallback;
}

/** Saves the setting's value, replacing the one before, stamped with the database's time. */
export async function setSetting<TKey extends SettingKey>(key: TKey, value: SettingValues[TKey]): Promise<void> {
  // Bound as JSON text: drizzle would send a bare null as SQL NULL, which the column refuses.
  const json = sql`${JSON.stringify(value)}::jsonb`;
  await getDb()
    .insert(settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: settings.key, set: { value: json, updatedAt: sql`now()` } });
}
