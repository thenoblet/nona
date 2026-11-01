import { describe, expect, it } from "vitest";
import type { AlbumItem } from "@/lib/media/album-item";
import { pollServerThumb } from "./server-thumb";

/*
 * Ruling BB: a file the phone can't draw (a HEIC on Android) shows an icon on its card; once it is
 * added, the card asks the album for the server's own thumbnail, briefly, and swaps it in.
 */

const noWait = async () => {};

function answers(...sequence: (Partial<AlbumItem> | null | Error)[]) {
  const asked: string[] = [];
  let at = 0;
  return {
    asked,
    fetchItem: async (mediaId: string) => {
      asked.push(mediaId);
      const next = sequence[Math.min(at, sequence.length - 1)];
      at += 1;
      if (next instanceof Error) throw next;
      return next === null ? null : ({ thumb: null, ...next } as AlbumItem);
    },
  };
}

describe("pollServerThumb", () => {
  it("asks until the item has its thumbnail, then gives it", async () => {
    const server = answers({ status: "uploaded" }, new Error("dropped"), { status: "ready", thumb: "https://media.example/thumb.webp" });
    const thumb = await pollServerThumb("media-1", { fetchItem: server.fetchItem, wait: noWait, attempts: 10, signal: new AbortController().signal });
    expect(thumb).toBe("https://media.example/thumb.webp");
    expect(server.asked).toEqual(["media-1", "media-1", "media-1"]);
  });

  it("gives up after its attempts, or at once when the item is gone, or when it is stopped", async () => {
    const slow = answers({ status: "uploaded" });
    expect(await pollServerThumb("media-1", { fetchItem: slow.fetchItem, wait: noWait, attempts: 4, signal: new AbortController().signal })).toBeNull();
    expect(slow.asked).toHaveLength(4);

    const gone = answers(null);
    expect(await pollServerThumb("media-1", { fetchItem: gone.fetchItem, wait: noWait, attempts: 4, signal: new AbortController().signal })).toBeNull();
    expect(gone.asked).toHaveLength(1);

    const stopped = new AbortController();
    stopped.abort();
    const never = answers({ status: "ready", thumb: "https://media.example/thumb.webp" });
    expect(await pollServerThumb("media-1", { fetchItem: never.fetchItem, wait: noWait, attempts: 4, signal: stopped.signal })).toBeNull();
    expect(never.asked).toEqual([]);
  });
});
