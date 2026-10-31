import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "@/lib/data/settings";
import { resetDb } from "../../../../test/db";

vi.mock("next/server", () => ({ connection: async () => {} }));

// `readFails` makes reading the heartbeat throw, as an unreachable database would.
const database = vi.hoisted(() => ({ readFails: false }));
vi.mock("@/lib/data/settings", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/data/settings")>();
  return {
    ...real,
    getSetting: (async (...args: Parameters<typeof real.getSetting>) => {
      if (database.readFails) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      return real.getSetting(...args);
    }) as typeof real.getSetting,
  };
});

import { GET } from "./route";

const MINUTE = 60_000;

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

beforeEach(async () => {
  database.readFails = false;
  await resetDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/worker-health", () => {
  it("answers 503 before the worker has ever beaten", async () => {
    const response = await GET();
    expect(response.status).toBe(503);
  });

  it("answers 200 while the heartbeat is under 2 minutes old", async () => {
    await setSetting("worker_heartbeat", secondsAgo(30));
    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("answers 503 once the heartbeat is 2 minutes old or more", async () => {
    await setSetting("worker_heartbeat", new Date(Date.now() - 2 * MINUTE - 1000).toISOString());
    expect((await GET()).status).toBe(503);
  });

  it("answers 503 for a heartbeat from a clock far ahead, or one that isn't a time", async () => {
    await setSetting("worker_heartbeat", new Date(Date.now() + 10 * MINUTE).toISOString());
    expect((await GET()).status).toBe(503);
    await setSetting("worker_heartbeat", "not a time");
    expect((await GET()).status).toBe(503);
  });

  it("answers 503 when the database can't be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    database.readFails = true;
    expect((await GET()).status).toBe(503);
  });

  it("says nothing else, and no cache keeps the answer", async () => {
    await setSetting("worker_heartbeat", secondsAgo(5));
    const response = await GET();
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
