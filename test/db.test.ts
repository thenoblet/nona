import { afterEach, describe, expect, it, vi } from "vitest";
import { resetDb, saveTestSetting } from "./db";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resetDb", () => {
  it("refuses a database whose name does not end in _test", async () => {
    // A name that exists nowhere, so this can never empty a real database, even if the guard fails.
    vi.stubEnv("POSTGRES_DB", "nona_live_copy");
    await expect(resetDb()).rejects.toThrow('resetDb only empties a test database; "nona_live_copy" does not end in _test');
  });
});

describe("saveTestSetting", () => {
  it("refuses a database whose name does not end in _test", async () => {
    vi.stubEnv("POSTGRES_DB", "nona_live_copy");
    await expect(saveTestSetting("uploads_open", true)).rejects.toThrow(
      'saveTestSetting only changes a test database; "nona_live_copy" does not end in _test',
    );
  });
});
