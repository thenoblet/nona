import postgres from "postgres";
import { dbConfig } from "@/lib/env";

export async function resetDb(): Promise<void> {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    await sql`TRUNCATE rsvps, rsvp_flag_dismissals, site_content`;
  } finally {
    await sql.end();
  }
}
