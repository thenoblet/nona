import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "./client";

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
