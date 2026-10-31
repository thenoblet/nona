import { describe, expect, it } from "vitest";
import { isChunkLoadError, reloadOnceAfterChunkError } from "./load";

function sessionStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

describe("loading the uploader", () => {
  it("knows a chunk a deploy removed from other failures", () => {
    // Turbopack's runtime names the error; browsers word a failed import() their own way.
    expect(isChunkLoadError(Object.assign(new Error("Failed to load chunk /_next/static/chunks/x.js"), { name: "ChunkLoadError" }))).toBe(true);
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://example.com/x.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isChunkLoadError("ChunkLoadError")).toBe(false);
  });

  it("reloads the page once after a deploy, and not again within ten minutes, so it can never loop", () => {
    const storage = sessionStore();
    const reloads: number[] = [];
    const reload = () => reloads.push(1);

    expect(reloadOnceAfterChunkError({ storage, reload, now: 1_000 })).toBe(true);
    expect(reloadOnceAfterChunkError({ storage, reload, now: 1_000 + 9 * 60_000 })).toBe(false);
    expect(reloads).toHaveLength(1);
    expect(reloadOnceAfterChunkError({ storage, reload, now: 1_000 + 11 * 60_000 })).toBe(true);
    expect(reloads).toHaveLength(2);
  });

  it("never reloads when it can't remember having done so", () => {
    const reloads: number[] = [];
    const blocked = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };

    expect(reloadOnceAfterChunkError({ storage: blocked, reload: () => reloads.push(1), now: 0 })).toBe(false);
    expect(reloadOnceAfterChunkError({ storage: null, reload: () => reloads.push(1), now: 0 })).toBe(false);
    expect(reloads).toEqual([]);
  });
});
