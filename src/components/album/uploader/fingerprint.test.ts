import { describe, expect, it } from "vitest";
import { FINGERPRINTS_AT_ONCE, FileReadError, fingerprintFile, readOnPick } from "./fingerprint";

/*
 * Reading a picked file for its fingerprint (Ruling BA): which read failed when the phone can no
 * longer read it, and the read starting the moment the file is picked, a few files at a time.
 */

const MEBIBYTE = 1024 * 1024;

/** A file whose slices can be made to fail or to wait, and which counts them. */
function fakeFile(options: { size?: number; failFrom?: "head" | "tail"; gate?: Promise<void> } = {}) {
  const size = options.size ?? 3 * MEBIBYTE;
  const reads: number[] = [];
  let reading = 0;
  let mostAtOnce = 0;
  const file = {
    name: "IMG-20261205-WA0007.jpg",
    type: "image/jpeg",
    size,
    lastModified: 0,
    slice(start: number, end: number) {
      return {
        async arrayBuffer() {
          reads.push(start);
          reading += 1;
          mostAtOnce = Math.max(mostAtOnce, reading);
          try {
            await options.gate;
            const failing = options.failFrom === "head" || (options.failFrom === "tail" && start > 0);
            if (failing) {
              throw new DOMException(
                "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
                "NotReadableError",
              );
            }
            return new ArrayBuffer(end - start);
          } finally {
            reading -= 1;
          }
        },
      };
    },
  } as unknown as File;
  return { file, reads, mostAtOnce: () => mostAtOnce };
}

describe("reading a file for its fingerprint", () => {
  it("says which read failed, keeping the browser's own error name and words", async () => {
    for (const failFrom of ["head", "tail"] as const) {
      const { file } = fakeFile({ failFrom });
      const failure = await fingerprintFile(file).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(FileReadError);
      expect(failure).toMatchObject({ name: "NotReadableError", read: failFrom });
      expect((failure as Error).message).toMatch(/could not be read/);
    }
  });

  it("starts the moment a file is picked, and the uploader takes that same read", async () => {
    const { file, reads } = fakeFile();
    const atPick = readOnPick(file);
    const byTheUploader = readOnPick(file);

    expect(byTheUploader).toBe(atPick);
    expect(await atPick).toMatch(/^[0-9a-f]{64}$/);
    expect(reads).toEqual([0, 2 * MEBIBYTE]);
  });

  it("reads a few picked files at a time, not a whole batch at once", async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const files = Array.from({ length: 8 }, () => fakeFile({ gate }));
    const reading = files.map(({ file }) => readOnPick(file));
    await new Promise((resolve) => setTimeout(resolve, 10));

    const started = files.filter(({ reads }) => reads.length > 0).length;
    expect(started).toBe(FINGERPRINTS_AT_ONCE);
    open();
    await Promise.all(reading);
    expect(files.every(({ reads }) => reads.length === 2)).toBe(true);
    expect(FINGERPRINTS_AT_ONCE).toBeLessThanOrEqual(4);
  });

  it("reads a file again after a failed read, rather than keeping the failure", async () => {
    const { file, reads } = fakeFile({ failFrom: "head" });
    await expect(readOnPick(file)).rejects.toMatchObject({ name: "NotReadableError" });
    await expect(readOnPick(file)).rejects.toMatchObject({ name: "NotReadableError" });
    expect(reads).toEqual([0, 0]);
  });
});
