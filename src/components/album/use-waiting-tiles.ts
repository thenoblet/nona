"use client";

import { useEffect, useRef } from "react";
import type { AlbumItem } from "@/lib/media/album-item";
import { itemWatch } from "./item-watch";

/** How long the album asks after the guest's own moments being made ready, after the page shows them. */
const WAITING_GIVE_UP_MILLISECONDS = 3 * 60_000;

/**
 * The guest's own moments being made ready ("Getting it ready" tiles) ask after themselves through
 * the page's shared check (item-watch.ts: all of them in one request every 5 s, rounds never
 * overlapping; fix round 1, Important #2), for three minutes. Each one's news comes once: the moment
 * as it is now (ready, or failed), or null once it has gone. Still being made, it says nothing.
 */
export function useWaitingTiles(waitingIds: readonly string[], onNews: (mediaId: string, item: AlbumItem | null) => void): void {
  const key = waitingIds.join(",");
  const latest = useRef(onNews);
  useEffect(() => {
    latest.current = onNews;
  });
  useEffect(() => {
    if (!key) return;
    const watch = itemWatch();
    const stops = key.split(",").map((mediaId) => {
      const stop = watch.watch(mediaId, (item) => {
        if (item?.status === "uploaded") return;
        stop();
        latest.current(mediaId, item);
      });
      return stop;
    });
    const giveUp = window.setTimeout(() => stops.forEach((stop) => stop()), WAITING_GIVE_UP_MILLISECONDS);
    return () => {
      window.clearTimeout(giveUp);
      stops.forEach((stop) => stop());
    };
  }, [key]);
}
