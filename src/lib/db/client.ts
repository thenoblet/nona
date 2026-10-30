import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

// Next loads this file once per server bundle, so a module variable would open several pools.
// The globalThis key is shared by every bundle in the process, as the job queue's is.
const globalWithDb = globalThis as typeof globalThis & {
  __nonaDb?: Database;
};

// One pool per process, opened on first use. A stalled query is cut off after 10 s so it
// cannot hold a guest's request.
export function getDb(): PostgresJsDatabase<typeof schema> {
  globalWithDb.__nonaDb ??= drizzle(
    postgres({
      ...dbConfig(),
      max: 10,
      connect_timeout: 5,
      connection: { statement_timeout: 10_000 },
    }),
    { schema },
  );
  return globalWithDb.__nonaDb;
}

/**
 * Closes the pool, if one was opened, giving queries in flight `timeoutSeconds` to finish: the
 * media worker does this as it stops. The next getDb() would open a new one.
 */
export async function closeDb(timeoutSeconds = 1): Promise<void> {
  const db = globalWithDb.__nonaDb;
  if (!db) return;
  globalWithDb.__nonaDb = undefined;
  await db.$client.end({ timeout: timeoutSeconds });
}
