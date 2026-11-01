import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import type { AlbumItem } from "@/lib/media/album-item";
import { createItemWatch, ITEM_WATCH_MILLISECONDS, SLOW_AFTER_MILLISECONDS, type Visibility } from "./item-watch";

/*
 * Fix round 1, Important #2: the album's waiting tiles and the uploader's cards ask after their
 * moments through one shared check: every watched moment in one request a tick, each round starting
 * only once the last has finished, so an honest guest never runs into the `item` limit.
 */

const moment = (id: string, status: AlbumItem["status"] = "uploaded") => ({ id, status, thumb: status === "ready" ? `https://media.example/${id}.webp` : null }) as AlbumItem;
const ids = (count: number, prefix = "moment") => Array.from({ length: count }, (_unused, index) => `${prefix}-${index}`);

/** A page whose visibility the test sets, telling its listeners as a browser's visibilitychange would. */
function fakeVisibility(visible: boolean): Visibility & { set: (visible: boolean) => void } {
  let current = visible;
  const listeners = new Set<() => void>();
  return {
    isVisible: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

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

  it("Ruling BQ: asks every 5 s for a moment's first 3 minutes, then every 30 s, until it is no longer watched", async () => {
    const askedAt: number[] = [];
    const watch = createItemWatch({ maxIds: 50, fetchItems: async (named) => (askedAt.push(Date.now()), named.map((id) => moment(id))) });
    const begun = Date.now();
    watch.watch("slow-photo", () => {});

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const offsets = askedAt.map((time) => time - begun);
    expect(offsets.filter((offset) => offset <= SLOW_AFTER_MILLISECONDS)).toHaveLength(SLOW_AFTER_MILLISECONDS / ITEM_WATCH_MILLISECONDS);
    expect(offsets.filter((offset) => offset > SLOW_AFTER_MILLISECONDS)).toEqual([210_000, 240_000, 270_000, 300_000, 330_000, 360_000]);
  });

  it("Ruling BQ: a moment watched for long is asked after every 30 s, while a new one beside it is asked every 5 s, one request a round", async () => {
    const asked: string[][] = [];
    const watch = createItemWatch({ maxIds: 50, fetchItems: async (named) => (asked.push(named), named.map((id) => moment(id))) });
    watch.watch("old-one", () => {});
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MILLISECONDS + 1_000);
    asked.length = 0;
    watch.watch("new-one", () => {});

    await vi.advanceTimersByTimeAsync(60_000);

    expect(asked.filter((named) => named.includes("new-one"))).toHaveLength(12);
    expect(asked.filter((named) => named.includes("old-one"))).toHaveLength(2);
    expect(asked.every((named) => new Set(named).size === named.length)).toBe(true);
  });

  it("Ruling BQ: pauses while the page is hidden, and checks again as soon as it is visible", async () => {
    const page = fakeVisibility(true);
    let calls = 0;
    const watch = createItemWatch({ maxIds: 50, visibility: page, fetchItems: async () => (calls += 1, []) });
    watch.watch("moment-1", () => {});
    await vi.advanceTimersByTimeAsync(ITEM_WATCH_MILLISECONDS);
    expect(calls).toBe(1);

    page.set(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBe(1);

    page.set(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    // Then on its usual pace (a moment watched for over 3 minutes: every 30 s).
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toBe(3);
  });

  it("keeps 50 waiting tiles inside the guest's `item` bucket for ten minutes", async () => {
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
    for (const id of ids(50, "tile")) watch.watch(id, () => {});

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    // 36 rounds in the first 3 minutes, then one every 30 s.
    expect(requests).toBe(36 + 14);
    expect(refused).toBe(0);
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
