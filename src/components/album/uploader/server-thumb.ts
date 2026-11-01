"use client";

import { createContext, use, useEffect } from "react";
import type { AlbumItem } from "@/lib/media/album-item";
import { fetchItem } from "../album-client";
import type { UploadItem } from "./state";

/*
 * Ruling BB: a file the phone can't draw (a HEIC on Android, a video it can't decode) shows a small
 * icon on its card. Once the server has it ("Added"), the card asks the album after it (GET
 * /api/media/[id]) a few seconds apart, briefly, and swaps in the server's own thumbnail once the
 * worker has made it: the card tidies itself away within seconds anyway.
 */

/** How often the card asks, and how many times: about the minute a card stays. */
const CHECK_MILLISECONDS = 2_000;
const CHECKS = 30;

/** Sets an item's serverThumbUrl in the uploader's store: the UploadProvider gives it. */
export const ServerThumbContext = createContext<((itemId: string, url: string) => void) | null>(null);

type Poll = {
  fetchItem: (mediaId: string) => Promise<AlbumItem | null>;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  attempts: number;
  signal: AbortSignal;
};

/** Asks after the item until it has a thumbnail; null once it is gone, after `attempts`, or when stopped. */
export async function pollServerThumb(mediaId: string, poll: Poll): Promise<string | null> {
  for (let attempt = 0; attempt < poll.attempts; attempt += 1) {
    if (poll.signal.aborted) return null;
    const item = await poll.fetchItem(mediaId).catch(() => undefined);
    if (poll.signal.aborted || item === null) return null;
    if (item?.thumb) return item.thumb;
    if (attempt < poll.attempts - 1) await poll.wait(CHECK_MILLISECONDS, poll.signal);
  }
  return null;
}

const wait = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** While a card's file shows only its icon (`needed`) and has been added, fetches the server's thumbnail into the store. */
export function useServerThumb(item: UploadItem, needed: boolean): void {
  const setThumb = use(ServerThumbContext);
  const { id, status, mediaId, serverThumbUrl } = item;
  useEffect(() => {
    if (!needed || !setThumb || status !== "added" || !mediaId || serverThumbUrl) return;
    const controller = new AbortController();
    pollServerThumb(mediaId, { fetchItem: (itemId) => fetchItem(itemId, controller.signal), wait, attempts: CHECKS, signal: controller.signal }).then((url) => {
      if (url && !controller.signal.aborted) setThumb(id, url);
    });
    return () => controller.abort();
  }, [needed, setThumb, id, status, mediaId, serverThumbUrl]);
}
