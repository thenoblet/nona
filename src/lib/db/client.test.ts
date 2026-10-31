import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "./client";

describe("getDb", () => {
  it("cuts off a statement that runs longer than 10 seconds", async () => {
    // performance.now() is monotonic: the wall clock can jump (WSL resyncs it) mid-test.
    const started = performance.now();
    await expect(getDb().execute(sql`SELECT pg_sleep(11)`)).rejects.toThrow();
    const seconds = (performance.now() - started) / 1000;
    expect(seconds).toBeGreaterThan(9);
    expect(seconds).toBeLessThan(15);
  }, 20_000);
});

describe("closeDb", () => {
  it("closes the pool, and the next getDb opens a new one that works", async () => {
    const before = getDb();
    await before.execute(sql`SELECT 1`);
    await closeDb();
    const after = getDb();
    expect(after).not.toBe(before);
    await expect(after.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it("does nothing when no pool is open", async () => {
    await closeDb();
    await expect(closeDb()).resolves.toBeUndefined();
  });
});
