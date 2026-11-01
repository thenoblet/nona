import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbumItem } from "@/lib/media/album-item";
import type { ItemWatch } from "../item-watch";
import { followServerThumb, SERVER_THUMB_GIVE_UP_MILLISECONDS } from "./server-thumb";

/*
 * Ruling BB: a card whose file the phone can't draw (a HEIC on Android) shows an icon, then, once
 * added, the server's own thumbnail. Fix round 1, Important #2: it asks through the album's shared
 * check (one request a tick for every moment watched, every 5 s), never on its own.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A stand-in for the shared check: the test tells each watcher what the album says. */
function fakeWatch() {
  const watchers = new Map<string, (item: AlbumItem | null) => void>();
  const watch: ItemWatch = {
    watch(mediaId, onChange) {
      watchers.set(mediaId, onChange);
      return () => watchers.delete(mediaId);
    },
  };
  return { watch, watchers };
}

describe("followServerThumb", () => {
  it("watches the moment on the shared check and takes its thumbnail once there is one, then stops watching", () => {
    const { watch, watchers } = fakeWatch();
    const thumbs: string[] = [];
    followServerThumb("media-1", { watch, onThumb: (url) => thumbs.push(url) });

    watchers.get("media-1")?.({ id: "media-1", status: "uploaded", thumb: null } as AlbumItem);
    expect(thumbs).toEqual([]);
    watchers.get("media-1")?.({ id: "media-1", status: "ready", thumb: "https://media.example/thumb.webp" } as AlbumItem);
    expect(thumbs).toEqual(["https://media.example/thumb.webp"]);
    expect(watchers.size).toBe(0);
  });

  it("stops watching once the moment is gone, after its minute, or when the card goes", () => {
    const gone = fakeWatch();
    followServerThumb("media-1", { watch: gone.watch, onThumb: () => {} });
    gone.watchers.get("media-1")?.(null);
    expect(gone.watchers.size).toBe(0);

    const slow = fakeWatch();
    followServerThumb("media-2", { watch: slow.watch, onThumb: () => {} });
    vi.advanceTimersByTime(SERVER_THUMB_GIVE_UP_MILLISECONDS);
    expect(slow.watchers.size).toBe(0);

    const tidied = fakeWatch();
    const stop = followServerThumb("media-3", { watch: tidied.watch, onThumb: () => {} });
    stop();
    expect(tidied.watchers.size).toBe(0);
  });
});
