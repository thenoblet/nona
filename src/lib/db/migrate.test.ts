import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { dbConfig } from "@/lib/env";
import { runMigrations } from "./migrate";

const sql = postgres({ ...dbConfig(), max: 1 });
afterAll(() => sql.end());

describe("runMigrations", () => {
  it("creates the tables", async () => {
    await runMigrations();
    const rows = await sql`select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((r) => r.table_name);
    expect(names).toContain("rsvps");
    expect(names).toContain("site_content");
  });

  it("lets two runs overlap", async () => {
    await expect(Promise.all([runMigrations(), runMigrations()])).resolves.toBeDefined();
  });
});
