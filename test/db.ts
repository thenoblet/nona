import postgres from "postgres";
import { dbConfig } from "@/lib/env";

/** The test database's settings; throws for any database whose name doesn't end in _test. */
function testDbConfig(action: string) {
  const config = dbConfig();
  if (!config.database.endsWith("_test")) {
    throw new Error(`${action} a test database; "${config.database}" does not end in _test`);
  }
  return config;
}

/** Empties the test database's tables. Refuses any database whose name doesn't end in _test. */
export async function resetDb(): Promise<void> {
  const config = testDbConfig("resetDb only empties");
  const sql = postgres({ ...config, max: 1 });
  try {
    await sql`TRUNCATE rsvps, rsvp_flag_dismissals, final_emails, final_whatsapp, site_content, guests, media, wishes, site_images, upload_events, settings, admin_viewers`;
  } finally {
    await sql.end();
  }
}

/**
 * Saves a setting in the test database, as the admin will (settings.ts is server-only, so the e2e
 * setup can't import it). Refuses any database whose name doesn't end in _test.
 */
export async function saveTestSetting(key: string, value: unknown): Promise<void> {
  const sql = postgres({ ...testDbConfig("saveTestSetting only changes"), max: 1 });
  try {
    await sql`
      insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::jsonb)
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } finally {
    await sql.end();
  }
}
