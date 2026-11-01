import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dbConfig } from "@/lib/env";
import { runMigrations } from "./migrate";

const sql = postgres({ ...dbConfig(), max: 1 });
afterAll(() => sql.end());

describe("runMigrations", () => {
  it("creates the tables", async () => {
    await runMigrations();
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((row) => row.table_name);
    expect(names).toContain("rsvps");
    expect(names).toContain("site_content");
    for (const table of ["guests", "media", "wishes", "site_images", "upload_events", "settings"]) {
      expect(names).toContain(table);
    }
  });

  it("indexes the album's pages, each guest's uploads and resumable uploads", async () => {
    await runMigrations();
    const rows = await sql<{ indexdef: string }[]>`select indexdef from pg_indexes where tablename = 'media'`;
    const columnLists = rows.map((row) => row.indexdef.replace(/^.* USING btree /, ""));
    expect(columnLists).toContain(
      "(purpose, status, listed_at DESC, id DESC) WHERE ((hidden_at IS NULL) AND (deleted_at IS NULL))",
    );
    expect(columnLists).toContain("(guest_id)");
    expect(columnLists).toContain("(guest_id, size_bytes, file_fingerprint) WHERE (status = 'uploading'::text)");
    // Ruling AX: the files the couple hid, by fingerprint.
    expect(columnLists).toContain(
      "(file_fingerprint, size_bytes) WHERE ((hidden_at IS NOT NULL) AND (NOT removed_by_uploader) AND (deleted_at IS NULL))",
    );
  });

  it("lets the album read a page after its cursor in order from the index, without sorting", async () => {
    await runMigrations();
    // From an empty album, analysed as empty, whatever an earlier run (the e2e's included) left
    // behind: a few rows, or the statistics they leave after a truncate, make a sort of them look
    // cheaper than the index's order, and the plan would show it.
    await sql`truncate media cascade`;
    await sql`analyze media`;
    const plan = await sql.begin(async (transaction) => {
      // The test table is nearly empty, so make the planner show what it would do with a full one.
      await transaction`set local enable_seqscan = off`;
      return transaction<{ "QUERY PLAN": string }[]>`
        explain select id from media
        where purpose = 'album' and status = 'ready' and hidden_at is null and deleted_at is null
          and (listed_at, id) < (now(), '00000000-0000-4000-8000-000000000000'::uuid)
        order by listed_at desc, id desc
        limit 30`;
    });
    const steps = plan.map((row) => row["QUERY PLAN"]).join("\n");
    expect(steps).toContain("media_album_cursor_idx");
    expect(steps).not.toContain("Sort");
  });

  it("lets two runs overlap", async () => {
    await expect(Promise.all([runMigrations(), runMigrations()])).resolves.toBeDefined();
  });

  it("fails fast instead of waiting forever for a held lock", async () => {
    const holder = postgres({ ...dbConfig(), max: 1 });
    await holder`SELECT pg_advisory_lock(472026)`;
    try {
      // performance.now() is monotonic: the wall clock can jump (WSL resyncs it) mid-test.
      const started = performance.now();
      await expect(runMigrations()).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(12_000);
    } finally {
      await holder`SELECT pg_advisory_unlock(472026)`;
      await holder.end();
    }
  }, 20_000);
});

describe("a database migrated from nothing", () => {
  // Its own database, so the shared test database's truncated settings don't hide the migration's.
  const FRESH_DATABASE = "nona_fresh_migrations_test";
  let fresh: postgres.Sql;

  async function migrateFresh(): Promise<void> {
    vi.stubEnv("POSTGRES_DB", FRESH_DATABASE);
    try {
      await runMigrations();
    } finally {
      vi.unstubAllEnvs();
    }
  }

  async function uploadsOpen(): Promise<unknown[]> {
    const rows = await fresh<{ value: unknown }[]>`select value from settings where key = 'uploads_open'`;
    return rows.map((row) => row.value);
  }

  beforeAll(async () => {
    await sql`drop database if exists ${sql(FRESH_DATABASE)} with (force)`;
    await sql`create database ${sql(FRESH_DATABASE)}`;
    fresh = postgres({ ...dbConfig(), database: FRESH_DATABASE, max: 1, onnotice: () => {} });
  }, 20_000);

  afterAll(async () => {
    await fresh?.end();
    await sql`drop database if exists ${sql(FRESH_DATABASE)} with (force)`;
  });

  it("starts with uploads closed, so a deploy never opens them before the couple do", async () => {
    await migrateFresh();
    expect(await uploadsOpen()).toEqual([false]);
  });

  it("keeps the couple's choice when the migrations run again at the next start", async () => {
    await fresh`update settings set value = 'true'::jsonb where key = 'uploads_open'`;
    await migrateFresh();
    expect(await uploadsOpen()).toEqual([true]);
  });
});
