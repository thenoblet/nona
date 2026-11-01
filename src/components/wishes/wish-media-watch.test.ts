import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createItemWatch, ITEM_WATCH_MILLISECONDS } from "@/components/album/item-watch";
import { createApiClient } from "@/components/album/uploader/api";
import { wishMediaFetcher, type WishMedia } from "./wish-media-watch";

/*
 * Ruling BU: the sender's pending wish cards ask after their recordings through Task 15's item-watch
 * scheduler, every card of the page in one batched read a round.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the sender's 'getting ready' check", () => {
  it("asks GET /api/wishes/media for every pending card in one request a round, and tells each card its news", async () => {
    const requests: string[] = [];
    const answers: Record<string, WishMedia["state"]> = { "recording-1": "processing", "recording-2": "ready" };
    const api = createApiClient({
      fetch: (async (input: string | URL | Request) => {
        requests.push(String(input));
        const ids = new URL(String(input), "https://example.com").searchParams.get("ids")?.split(",") ?? [];
        const items = ids.filter((id) => answers[id]).map((id) => ({ id, state: answers[id] }));
        return new Response(JSON.stringify({ items }), { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    });
    const watch = createItemWatch<WishMedia>({ fetchItems: wishMediaFetcher(api) });
    const heard: [string, WishMedia | null][] = [];
    for (const id of ["recording-1", "recording-2", "hidden-one"]) watch.watch(id, (item) => heard.push([id, item]));

    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);

    expect(requests).toEqual(["/api/wishes/media?ids=recording-1,recording-2,hidden-one"]);
    expect(heard).toEqual([
      ["recording-1", { id: "recording-1", state: "processing" }],
      ["recording-2", { id: "recording-2", state: "ready" }],
      // Left out by the read: gone, as a hidden or deleted wish is.
      ["hidden-one", null],
    ]);
  });

  it("waits out a 429 and asks again, never telling a card it failed", async () => {
    let calls = 0;
    const api = createApiClient({
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response(JSON.stringify({ error: "rate-limited" }), { status: 429, headers: { "Retry-After": "2" } });
        return new Response(JSON.stringify({ items: [{ id: "recording-1", state: "failed" }] }), { status: 200 });
      }) as typeof fetch,
      sleep: async () => {},
    });

    expect(await wishMediaFetcher(api)(["recording-1"])).toEqual([{ id: "recording-1", state: "failed" }]);
    expect(calls).toBe(2);
  });

  it("throws when the read answers otherwise, so the scheduler asks again next round", async () => {
    const api = createApiClient({ fetch: (async () => new Response("{}", { status: 503 })) as typeof fetch, sleep: async () => {} });
    await expect(wishMediaFetcher(api)(["recording-1"])).rejects.toThrow("503");
  });
});
