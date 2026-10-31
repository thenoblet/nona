import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import * as zod from "zod";
import { dbConfig } from "@/lib/env";
import { describeError } from "@/lib/log-error";

/*
 * The worker never migrates the database: the web app does, at its start-up. A worker deployed
 * with a newer schema than the database's waits here until the app has caught up, rather than
 * running queries against tables that aren't there yet. One applied by a newer app is fine.
 */

/** How often the worker looks again while it waits. */
export const SCHEMA_POLL_MILLISECONDS = 10_000;

/** A migration the worker was built with: its name, and the time Drizzle records it under. */
export type BundledMigration = { tag: string; createdAt: number };

const journalSchema = zod.object({
  entries: zod.array(zod.object({ tag: zod.string(), when: zod.number() })),
});

/** The migrations in the Drizzle journal the build copied beside the bundle (drizzle/meta/_journal.json). */
export async function readBundledMigrations(migrationsFolder: string): Promise<BundledMigration[]> {
  const journal = journalSchema.parse(JSON.parse(await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8")));
  return journal.entries.map((entry) => ({ tag: entry.tag, createdAt: entry.when }));
}

// Postgres's codes for a table, or a schema, that doesn't exist: a database never migrated.
const MISSING_TABLE_CODES = new Set(["42P01", "3F000"]);

/**
 * When each migration the database has applied was made: Drizzle's created_at, which is the
 * journal's `when` for that migration. None on a database that has never been migrated. Opens a
 * connection of its own, bounded like every other: 5 s to connect, 10 s for the query.
 */
export async function readAppliedMigrations(config: ReturnType<typeof dbConfig> = dbConfig()): Promise<number[]> {
  const sql = postgres({
    ...config,
    max: 1,
    connect_timeout: 5,
    connection: { statement_timeout: 10_000 },
    onnotice: () => {},
  });
  try {
    const rows = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations`;
    return rows.map((row) => Number(row.created_at));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && MISSING_TABLE_CODES.has(code)) return [];
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The bundled migrations the database hasn't applied. */
export function missingMigrations(bundled: BundledMigration[], applied: number[]): BundledMigration[] {
  const appliedTimes = new Set(applied);
  return bundled.filter((migration) => !appliedTimes.has(migration.createdAt));
}

export type SchemaWaitOptions = {
  /** The folder holding the bundled journal (meta/_journal.json). */
  migrationsFolder: string;
  /** Ends the wait early (the worker stopping): it rejects with the signal's reason. */
  signal?: AbortSignal;
  pollMilliseconds?: number;
  /** For tests: what the database has applied. */
  readApplied?: () => Promise<number[]>;
};

/**
 * Resolves once the database has applied every migration the worker was built with, looking every
 * 10 s until it has. A database it can't reach yet is waited for the same way. Logs "waiting for
 * schema" with what it is waiting for, again only when that changes, and "schema ready" at the end.
 */
export async function waitForSchema(options: SchemaWaitOptions): Promise<void> {
  const bundled = await readBundledMigrations(options.migrationsFolder);
  const readApplied = options.readApplied ?? (() => readAppliedMigrations());
  const pollMilliseconds = options.pollMilliseconds ?? SCHEMA_POLL_MILLISECONDS;
  let lastReported = "";
  for (;;) {
    options.signal?.throwIfAborted();
    let waitingFor: string;
    try {
      const missing = missingMigrations(bundled, await readApplied());
      if (missing.length === 0) {
        console.log(`[worker] schema ready: all ${bundled.length} migrations applied`);
        return;
      }
      waitingFor = `${missing.length} of ${bundled.length} migrations not applied yet (${missing.map((migration) => migration.tag).join(", ")})`;
    } catch (error) {
      waitingFor = `the database, which can't be read yet (${describeError(error)})`;
    }
    if (waitingFor !== lastReported) {
      console.log(`[worker] waiting for schema: ${waitingFor}; looking again every ${pollMilliseconds / 1000} s`);
      lastReported = waitingFor;
    }
    await delay(pollMilliseconds, undefined, { signal: options.signal });
  }
}
