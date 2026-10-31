import { describe, expect, it } from "vitest";
import { PartUrlCache } from "./presign-cache";

/** A /parts endpoint stand-in: records each call's part numbers and signs each with the call's count. */
function signer() {
  const calls: number[][] = [];
  const fetchUrls = async (partNumbers: number[]) => {
    calls.push(partNumbers);
    const call = calls.length;
    return partNumbers.map((partNumber) => ({ partNumber, url: `https://r2.example/part-${partNumber}?call=${call}` }));
  };
  return { calls, fetchUrls };
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_slot, index) => from + index);

describe("the part URL cache", () => {
  it("fetches twenty part URLs in one call and serves the next nineteen parts without another", async () => {
    const { calls, fetchUrls } = signer();
    const cache = new PartUrlCache({ partCount: 30, uploadedParts: [], fetchUrls });

    for (const partNumber of range(1, 20)) {
      expect(await cache.urlFor(partNumber)).toBe(`https://r2.example/part-${partNumber}?call=1`);
    }
    expect(await cache.urlFor(21)).toBe("https://r2.example/part-21?call=2");
    expect(calls).toEqual([range(1, 20), range(21, 30)]);
  });

  it("shares one call between parts asked for at once, as four parts in flight are", async () => {
    const { calls, fetchUrls } = signer();
    const cache = new PartUrlCache({ partCount: 4, uploadedParts: [], fetchUrls });

    const urls = await Promise.all([1, 2, 3, 4].map((partNumber) => cache.urlFor(partNumber)));

    expect(urls).toEqual(range(1, 4).map((partNumber) => `https://r2.example/part-${partNumber}?call=1`));
    expect(calls).toEqual([[1, 2, 3, 4]]);
  });

  it("never asks for a part R2 already holds, or one past the last", async () => {
    const { calls, fetchUrls } = signer();
    const cache = new PartUrlCache({ partCount: 6, uploadedParts: [1, 2, 4], fetchUrls });

    await cache.urlFor(3);

    expect(calls).toEqual([[3, 5, 6]]);
  });

  it("signs a part asked for again (a retry, or an expired link) afresh: each link is handed out once", async () => {
    const { calls, fetchUrls } = signer();
    const cache = new PartUrlCache({ partCount: 3, uploadedParts: [], fetchUrls });

    expect(await cache.urlFor(2)).toBe("https://r2.example/part-2?call=1");
    expect(await cache.urlFor(2)).toBe("https://r2.example/part-2?call=2");
    expect(calls).toEqual([[2, 3], [2]]);
  });

  it("asks again for a link fetched more than fifty minutes ago, before its hour runs out", async () => {
    const { calls, fetchUrls } = signer();
    let now = 0;
    const cache = new PartUrlCache({ partCount: 2, uploadedParts: [], fetchUrls, now: () => now });

    await cache.urlFor(1);
    now = 51 * 60 * 1000;
    expect(await cache.urlFor(2)).toBe("https://r2.example/part-2?call=2");
    expect(calls).toEqual([[1, 2], [2]]);
  });

  it("rejects every part waiting on a call that fails, and tries again on the next ask", async () => {
    let fail = true;
    const calls: number[][] = [];
    const cache = new PartUrlCache({
      partCount: 2,
      uploadedParts: [],
      fetchUrls: async (partNumbers) => {
        calls.push(partNumbers);
        if (fail) throw new Error("offline");
        return partNumbers.map((partNumber) => ({ partNumber, url: `u${partNumber}` }));
      },
    });

    const results = await Promise.allSettled([cache.urlFor(1), cache.urlFor(2)]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    fail = false;
    expect(await cache.urlFor(2)).toBe("u2");
    expect(calls).toEqual([[1, 2], [2]]);
  });

  it("refuses a link the server didn't send", async () => {
    const cache = new PartUrlCache({ partCount: 2, uploadedParts: [], fetchUrls: async () => [{ partNumber: 1, url: "u1" }] });

    await expect(cache.urlFor(2)).rejects.toThrow(/part 2/);
  });
});
