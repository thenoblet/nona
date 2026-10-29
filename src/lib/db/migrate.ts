import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";

const LOCK_ID = 472026;

// Own short-lived connection, serialised by an advisory lock so the app and the
// worker never migrate at the same time.
export async function runMigrations(): Promise<void> {
  const sql = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    // One connection, so these bound the lock wait and every migration statement.
    await sql`SET lock_timeout = '10s'`;
    await sql`SET statement_timeout = '60s'`;
    await sql`SELECT pg_advisory_lock(${LOCK_ID})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: join(process.cwd(), "drizzle") });
    } finally {
      await sql`SELECT pg_advisory_unlock(${LOCK_ID})`;
    }
  } finally {
    await sql.end();
  }
}
