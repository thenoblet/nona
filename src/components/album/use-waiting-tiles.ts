"use client";

import { useEffect, useRef } from "react";
import type { AlbumItem } from "@/lib/media/album-item";
import { itemWatch } from "./item-watch";

/**
 * The guest's own moments being made ready ("Getting it ready" tiles) ask after themselves through
 * the page's shared check (item-watch.ts: all of them in one request a round, rounds never
 * overlapping; fix round 1, Important #2) until each arrives: every 5 s for its first 3 minutes,
 * then every 30 s, paused while the page is hidden (ruling BQ). Each one's news comes once: the
 * moment as it is now (ready, or failed), or null once it has gone. Still being made, it says nothing.
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
    return () => stops.forEach((stop) => stop());
  }, [key]);
}
