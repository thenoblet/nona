import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "./client";

describe("getDb", () => {
  it("cuts off a statement that runs longer than 10 seconds", async () => {
    const started = Date.now();
    await expect(getDb().execute(sql`SELECT pg_sleep(11)`)).rejects.toThrow();
    const seconds = (Date.now() - started) / 1000;
    expect(seconds).toBeGreaterThan(9);
    expect(seconds).toBeLessThan(11);
  }, 20_000);
});
