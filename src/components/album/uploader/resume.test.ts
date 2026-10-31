import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSentFiles, fingerprintFile, type StorageLike } from "./resume";

const MEBIBYTE = 1024 * 1024;

/** The server's own check of a fingerprint (src/app/api/uploads/route.ts). */
const FINGERPRINT = /^[A-Za-z0-9+/=_-]{16,128}$/;

function memoryStorage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

describe("a file's fingerprint", () => {
  it("is the sha-256, in hex, of its size, its first MB and its last MB", async () => {
    const bytes = randomBytes(3 * MEBIBYTE + 17);
    const expected = createHash("sha256")
      .update(`${bytes.length}:`)
      .update(bytes.subarray(0, MEBIBYTE))
      .update(bytes.subarray(bytes.length - MEBIBYTE))
      .digest("hex");

    const fingerprint = await fingerprintFile(new Blob([bytes]));

    expect(fingerprint).toBe(expected);
    expect(fingerprint).toMatch(FINGERPRINT);
  });

  it("is the same for the same file renamed, and differs when its size or either end changes", async () => {
    const bytes = randomBytes(2 * MEBIBYTE + 5);
    const original = await fingerprintFile(new File([bytes], "IMG_0001.MOV"));

    expect(await fingerprintFile(new File([bytes], "renamed.mov"))).toBe(original);
    const lastByteChanged = Buffer.from(bytes);
    lastByteChanged[lastByteChanged.length - 1] ^= 1;
    expect(await fingerprintFile(new Blob([lastByteChanged]))).not.toBe(original);
    const firstByteChanged = Buffer.from(bytes);
    firstByteChanged[0] ^= 1;
    expect(await fingerprintFile(new Blob([firstByteChanged]))).not.toBe(original);
    expect(await fingerprintFile(new Blob([bytes, new Uint8Array(1)]))).not.toBe(original);
  });

  it("takes a file smaller than a MB whole, twice over", async () => {
    const bytes = randomBytes(1000);
    const expected = createHash("sha256").update("1000:").update(bytes).update(bytes).digest("hex");

    expect(await fingerprintFile(new Blob([bytes]))).toBe(expected);
  });

  it("reads only two 1 MB slices of a 2 GB video, never the whole file", async () => {
    const size = 2 * 1024 * MEBIBYTE;
    const slices: [number, number][] = [];
    const video = {
      size,
      slice(start: number, end: number) {
        slices.push([start, end]);
        return new Blob([new Uint8Array(end - start)]);
      },
      arrayBuffer() {
        throw new Error("read the whole file");
      },
    } as unknown as Blob;

    expect(await fingerprintFile(video)).toMatch(/^[0-9a-f]{64}$/);
    expect(slices).toEqual([
      [0, MEBIBYTE],
      [size - MEBIBYTE, size],
    ]);
  });
});

describe("the files this phone has sent", () => {
  it("remembers which upload a file went to, across page loads, until it is forgotten", () => {
    const storage = memoryStorage();
    createSentFiles(storage).remember(5000, "f1", "media-1");

    const later = createSentFiles(storage);
    expect(later.find(5000, "f1")).toBe("media-1");
    expect(later.find(5001, "f1")).toBeNull();
    later.forget(5000, "f1");
    expect(createSentFiles(storage).find(5000, "f1")).toBeNull();
  });

  it("keeps the newest 400 and drops the oldest", () => {
    const storage = memoryStorage();
    const sent = createSentFiles(storage);
    for (let index = 0; index < 405; index += 1) sent.remember(index, `f${index}`, `media-${index}`);

    const later = createSentFiles(storage);
    expect(later.find(0, "f0")).toBeNull();
    expect(later.find(4, "f4")).toBeNull();
    expect(later.find(5, "f5")).toBe("media-5");
    expect(later.find(404, "f404")).toBe("media-404");
  });

  it("carries on, remembering nothing, when storage is blocked or holds something it can't read", () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const sent = createSentFiles(blocked);
    expect(() => sent.remember(1, "f", "m")).not.toThrow();
    expect(sent.find(1, "f")).toBeNull();
    expect(() => sent.forget(1, "f")).not.toThrow();

    const corrupt = memoryStorage();
    corrupt.setItem("nona:sent-files", "{not json");
    expect(createSentFiles(corrupt).find(1, "f")).toBeNull();
    expect(createSentFiles(null).find(1, "f")).toBeNull();
  });
});
