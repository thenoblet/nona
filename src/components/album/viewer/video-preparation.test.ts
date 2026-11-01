import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbumItem } from "@/lib/media/album-item";
import { followPreparation, PREPARING_CHECK_MILLISECONDS } from "./video-preparation";

/*
 * A video this phone can't play yet (gate B 1a): the viewer asks for its phone version and asks
 * after it every 10 s. Fix round 1, Minor #2: once the moment has gone (hidden or removed), it stops
 * and says so, rather than ask for as long as the viewer stays open.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

const video = { id: "video-1", status: "ready", kind: "video" } as AlbumItem;

describe("followPreparation", () => {
  it("stops asking once the moment has gone, and says so once", async () => {
    let checks = 0;
    let gone = 0;
    const following = followPreparation({
      mediaId: "video-1",
      askNow: false,
      fetchItem: async () => (checks += 1, null),
      askPlayable: async () => ({ status: "preparing" }),
      onItem: () => {},
      onAnswer: () => {},
      onGone: () => (gone += 1),
      wait,
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(10 * PREPARING_CHECK_MILLISECONDS);
    await following;
    expect(checks).toBe(1);
    expect(gone).toBe(1);
  });

  it("asks after the moment every 10 s, and after a minute with no copy asks for its conversion instead", async () => {
    const asked: number[] = [];
    let checks = 0;
    const controller = new AbortController();
    const began = Date.now();
    void followPreparation({
      mediaId: "video-1",
      askNow: false,
      fetchItem: async () => (checks += 1, video),
      askPlayable: async () => (asked.push(Date.now() - began), { status: "preparing" }),
      onItem: () => {},
      onAnswer: () => {},
      onGone: () => {},
      wait,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(75_000);
    controller.abort();
    expect(checks).toBe(7);
    expect(asked).toEqual([60_000]);
  });

  it("stops the moment it is told to", async () => {
    let checks = 0;
    const controller = new AbortController();
    const following = followPreparation({
      mediaId: "video-1",
      askNow: true,
      fetchItem: async () => (checks += 1, video),
      askPlayable: async () => ({ status: "preparing" }),
      onItem: () => {},
      onAnswer: () => {},
      onGone: () => {},
      wait,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(PREPARING_CHECK_MILLISECONDS + 100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(10 * PREPARING_CHECK_MILLISECONDS);
    await following;
    expect(checks).toBe(1);
  });
});
