import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dbConfig } from "@/lib/env";
import { readAppliedMigrations, readBundledMigrations, waitForSchema } from "./schema-ready";

const projectMigrations = fileURLToPath(new URL("../../drizzle", import.meta.url));

/** A migrations folder whose journal lists these migrations, as the bundle carries one. */
async function journalFolder(entries: { tag: string; when: number }[]): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "nona-journal-"));
  await mkdir(join(folder, "meta"));
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "postgresql", entries: entries.map((entry, index) => ({ idx: index, ...entry })) }),
  );
  return folder;
}

const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("waitForSchema", () => {
  it("waits while a bundled migration is missing, then goes on once the app has applied it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = await journalFolder([
      { tag: "0000_first", when: 1000 },
      { tag: "0001_second", when: 2000 },
    ]);
    folders.push(folder);
    let applied = [1000];
    let ready = false;
    const waiting = waitForSchema({
      migrationsFolder: folder,
      pollMilliseconds: 20,
      readApplied: async () => applied,
    }).then(() => (ready = true));

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ready).toBe(false);
    expect(log.mock.calls.map((call) => String(call[0]))).toEqual(
      expect.arrayContaining([expect.stringContaining("waiting for schema")]),
    );

    applied = [1000, 2000];
    await waiting;
    expect(ready).toBe(true);
    expect(String(log.mock.calls.at(-1)?.[0])).toContain("schema ready");
  });

  it("accepts an extra applied migration: the app may be newer than the worker", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = await journalFolder([{ tag: "0000_first", when: 1000 }]);
    folders.push(folder);
    await expect(
      waitForSchema({ migrationsFolder: folder, pollMilliseconds: 20, readApplied: async () => [1000, 2000] }),
    ).resolves.toBeUndefined();
  });

  it("keeps waiting through a database it can't reach yet", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = await journalFolder([{ tag: "0000_first", when: 1000 }]);
    folders.push(folder);
    let attempts = 0;
    await waitForSchema({
      migrationsFolder: folder,
      pollMilliseconds: 20,
      readApplied: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        return [1000];
      },
    });
    expect(attempts).toBe(3);
  });

  it("stops waiting when the worker is told to stop", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const folder = await journalFolder([{ tag: "0000_first", when: 1000 }]);
    folders.push(folder);
    const stop = new AbortController();
    const waiting = waitForSchema({
      migrationsFolder: folder,
      pollMilliseconds: 10_000,
      readApplied: async () => [],
      signal: stop.signal,
    });
    stop.abort();
    await expect(waiting).rejects.toThrow();
  });

  it("is satisfied at once by the test database, which global setup migrated with the project's journal", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const started = Date.now();
    await waitForSchema({ migrationsFolder: projectMigrations });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("readBundledMigrations", () => {
  it("reads every migration of the project's journal", async () => {
    const bundled = await readBundledMigrations(projectMigrations);
    expect(bundled.length).toBeGreaterThanOrEqual(4);
    expect(bundled[0]).toEqual({ tag: "0000_fine_ezekiel", createdAt: 1793316935056 });
  });
});

describe("readAppliedMigrations", () => {
  // A database of its own, never migrated: what the worker finds on a fresh deploy.
  const EMPTY_DATABASE = "nona_worker_empty_test";
  const admin = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });

  beforeAll(async () => {
    await admin.unsafe(`drop database if exists ${EMPTY_DATABASE}`);
    await admin.unsafe(`create database ${EMPTY_DATABASE}`);
  });

  afterAll(async () => {
    await admin.unsafe(`drop database if exists ${EMPTY_DATABASE}`);
    await admin.end();
  });

  it("finds nothing applied on a database that has never been migrated", async () => {
    await expect(readAppliedMigrations({ ...dbConfig(), database: EMPTY_DATABASE })).resolves.toEqual([]);
  });

  it("finds every migration of the journal applied on the test database", async () => {
    const applied = await readAppliedMigrations();
    const bundled = await readBundledMigrations(projectMigrations);
    expect(applied).toEqual(expect.arrayContaining(bundled.map((migration) => migration.createdAt)));
  });
});
