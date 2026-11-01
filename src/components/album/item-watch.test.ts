import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import type { AlbumItem } from "@/lib/media/album-item";
import { createItemWatch, ITEM_WATCH_MILLISECONDS } from "./item-watch";

/*
 * Fix round 1, Important #2: the album's waiting tiles and the uploader's cards ask after their
 * moments through one shared check: every watched moment in one request a tick, each round starting
 * only once the last has finished, so an honest guest never runs into the `item` limit.
 */

const moment = (id: string, status: AlbumItem["status"] = "uploaded") => ({ id, status, thumb: status === "ready" ? `https://media.example/${id}.webp` : null }) as AlbumItem;
const ids = (count: number, prefix = "moment") => Array.from({ length: count }, (_unused, index) => `${prefix}-${index}`);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createItemWatch", () => {
  it("asks after every watched moment in one request a tick", async () => {
    const asked: string[][] = [];
    const watch = createItemWatch({ fetchItems: async (named) => (asked.push(named), named.map((id) => moment(id))), maxIds: 50 });
    for (const id of ids(50)) watch.watch(id, () => {});

    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(50);
    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);
    expect(asked).toHaveLength(2);
  });

  it("never starts a round while the last is still out, and waits its interval after it finishes", async () => {
    let inFlight = 0;
    let mostAtOnce = 0;
    const started: number[] = [];
    const watch = createItemWatch({
      maxIds: 50,
      fetchItems: async (named) => {
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        started.push(Date.now());
        // A slow answer: 12 s, longer than the interval.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        inFlight -= 1;
        return named.map((id) => moment(id));
      },
    });
    watch.watch("moment-1", () => {});
    const begun = Date.now();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mostAtOnce).toBe(1);
    expect(started.map((time) => time - begun)).toEqual([5_000, 22_000, 39_000, 56_000]);
  });

  it("tells each watcher its moment's news, a moment gone as null, and stops asking once nothing is watched", async () => {
    let calls = 0;
    const watch = createItemWatch({
      maxIds: 50,
      fetchItems: async () => {
        calls += 1;
        return [moment("ready-one", "ready")];
      },
    });
    const heard: (AlbumItem | null)[] = [];
    const stopReady = watch.watch("ready-one", (item) => heard.push(item));
    const stopGone = watch.watch("gone-one", (item) => heard.push(item));

    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);
    expect(heard).toEqual([expect.objectContaining({ id: "ready-one", status: "ready" }), null]);

    stopReady();
    stopGone();
    await vi.advanceTimersByTimeAsync(10 * ITEM_WATCH_MILLISECONDS);
    expect(calls).toBe(1);
  });

  it("asks again next tick after a request that failed, and takes turns past 50 watched moments", async () => {
    const asked: string[][] = [];
    let failNext = true;
    const watch = createItemWatch({
      maxIds: 50,
      fetchItems: async (named) => {
        asked.push(named);
        if (failNext) {
          failNext = false;
          throw new Error("The connection dropped");
        }
        return [];
      },
    });
    for (const id of ids(70)) watch.watch(id, () => {});

    await vi.advanceTimersByTimeAsync(3 * ITEM_WATCH_MILLISECONDS);

    expect(asked.map((named) => named.length)).toEqual([50, 50, 50]);
    // Every one of the 70 is asked after within two rounds.
    expect(new Set([...asked[1], ...asked[2]]).size).toBe(70);
  });

  it("asks nothing while the page isn't on screen, and carries on once it is", async () => {
    let visible = false;
    let calls = 0;
    const watch = createItemWatch({ maxIds: 50, isVisible: () => visible, fetchItems: async () => (calls += 1, []) });
    watch.watch("moment-1", () => {});
    await vi.advanceTimersByTimeAsync(4 * ITEM_WATCH_MILLISECONDS);
    expect(calls).toBe(0);
    visible = true;
    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);
    expect(calls).toBe(1);
  });

  it("keeps 50 waiting tiles and a batch's cards inside the guest's `item` bucket for two minutes", async () => {
    const guestId = `guest-${Math.random()}`;
    let requests = 0;
    let refused = 0;
    const watch = createItemWatch({
      maxIds: 50,
      fetchItems: async (named) => {
        requests += 1;
        if (!takeToken(guestId, "item", Date.now()).allowed) refused += 1;
        return named.map((id) => moment(id));
      },
    });
    // The album's 50 waiting tiles, and the uploader's 40 cards that couldn't draw their file.
    for (const id of [...ids(50, "tile"), ...ids(40, "card")]) watch.watch(id, () => {});

    await vi.advanceTimersByTimeAsync(120_000);

    expect(requests).toBe(120_000 / ITEM_WATCH_MILLISECONDS);
    expect(requests).toBeLessThan(RATE_LIMITS.item.burst);
    expect(refused).toBe(0);
  });
});
