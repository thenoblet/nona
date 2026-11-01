"use client";

import { createContext, use, useEffect } from "react";
import { itemWatch, type ItemWatch } from "../item-watch";
import type { UploadItem } from "./state";

/*
 * Ruling BB: when the phone can't draw a file (a HEIC on Android, a video it can't decode), its card
 * shows a small icon. Once the server has it ("Added"), the card waits for the server's own
 * thumbnail through the album's shared check (item-watch.ts: every moment the page waits on in one
 * request every 5 s; fix round 1, Important #2), for at most a minute: the card tidies itself away
 * within seconds anyway.
 */

/** How long a card waits for the server's thumbnail. */
export const SERVER_THUMB_GIVE_UP_MILLISECONDS = 60_000;

/** Sets an item's serverThumbUrl in the uploader's store: the UploadProvider gives it. */
export const ServerThumbContext = createContext<((itemId: string, url: string) => void) | null>(null);

/**
 * Watches the moment until it has a thumbnail (then hands it over), it has gone, or a minute has
 * passed. Returns what stops it sooner (the card going).
 */
export function followServerThumb(mediaId: string, options: { watch: ItemWatch; onThumb: (url: string) => void }): () => void {
  let stopWatching: () => void = () => {};
  const giveUp = setTimeout(() => stop(), SERVER_THUMB_GIVE_UP_MILLISECONDS);
  function stop(): void {
    clearTimeout(giveUp);
    stopWatching();
  }
  stopWatching = options.watch.watch(mediaId, (item) => {
    if (item === null) stop();
    else if (item.thumb) {
      stop();
      options.onThumb(item.thumb);
    }
  });
  return stop;
}

/** While a card's file shows only its icon (`needed`) and has been added, fetches the server's thumbnail into the store. */
export function useServerThumb(item: UploadItem, needed: boolean): void {
  const setThumb = use(ServerThumbContext);
  const { id, status, mediaId, serverThumbUrl } = item;
  useEffect(() => {
    if (!needed || !setThumb || status !== "added" || !mediaId || serverThumbUrl) return;
    return followServerThumb(mediaId, { watch: itemWatch(), onThumb: (url) => setThumb(id, url) });
  }, [needed, setThumb, id, status, mediaId, serverThumbUrl]);
}
