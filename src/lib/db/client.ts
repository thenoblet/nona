import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { dbConfig } from "@/lib/env";
import * as schema from "./schema";

let db: PostgresJsDatabase<typeof schema> | undefined;

// One pool per process, opened on first use.
export function getDb(): PostgresJsDatabase<typeof schema> {
  db ??= drizzle(postgres({ ...dbConfig(), max: 10, connect_timeout: 5 }), { schema });
  return db;
}
