import postgres from "postgres";
import { dbConfig } from "@/lib/env";

/** Empties the test database's tables. Refuses any database whose name doesn't end in _test. */
export async function resetDb(): Promise<void> {
  const config = dbConfig();
  if (!config.database.endsWith("_test")) {
    throw new Error(`resetDb only empties a test database; "${config.database}" does not end in _test`);
  }
  const sql = postgres({ ...config, max: 1 });
  try {
    await sql`TRUNCATE rsvps, rsvp_flag_dismissals, site_content, guests, media, wishes, site_images, upload_events, settings`;
  } finally {
    await sql.end();
  }
}
