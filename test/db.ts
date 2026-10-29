import postgres from "postgres";
import { dbConfig } from "@/lib/env";

export async function resetDb(): Promise<void> {
  const sql = postgres({ ...dbConfig(), max: 1 });
  try {
    await sql`TRUNCATE rsvps, site_content`;
  } finally {
    await sql.end();
  }
}
