import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import * as schema from "./schema";

let db: PostgresJsDatabase<typeof schema> | undefined;

// One pool per process, opened on first use. A stalled query is cut off after 10 s so it
// cannot hold a guest's request.
export function getDb(): PostgresJsDatabase<typeof schema> {
  db ??= drizzle(
    postgres({
      ...dbConfig(),
      max: 10,
      connect_timeout: 5,
      connection: { statement_timeout: 10_000 },
    }),
    { schema },
  );
  return db;
}
