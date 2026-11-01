"use client";

import { useEffect, useState } from "react";
import type { AlbumItem } from "@/lib/media/album-item";
import { askPlayable, fetchItem } from "../album-client";
import { choosePlayback, type PlaybackChoice } from "./playback";
import { abortableWait } from "./save";
import { followPreparation } from "./video-preparation";

/*
 * A video this phone can't play yet, for the viewer (gate B 1a): follows its preparation
 * (video-preparation.ts) while it is on screen, hands each newer state of the moment on, and shows
 * "Ready to play" for a moment once a version this phone plays has come. Stops when the moment
 * changes, the viewer closes, or the moment has gone (then `onGone`, once).
 */
export function useVideoPreparation(options: {
  item: AlbumItem | undefined;
  playback: PlaybackChoice | null;
  onChanged: (item: AlbumItem) => void;
  onGone: (item: AlbumItem) => void;
}): { readyChip: string | null } {
  const { item, playback, onChanged, onGone } = options;
  const [readyChip, setReadyChip] = useState<string | null>(null);
  useEffect(() => {
    if (!item?.video || playback?.kind !== "preparing") return;
    const controller = new AbortController();
    const mediaId = item.id;
    /** A newer state of the moment: once it plays here, the chip says so. */
    const learn = (fresh: AlbumItem) => {
      onChanged(fresh);
      const now = fresh.video ? choosePlayback(fresh.video, (type) => document.createElement("video").canPlayType(type)) : null;
      if (now?.kind === "converted" || now?.kind === "copy") {
        setReadyChip(mediaId);
        window.setTimeout(() => setReadyChip((shown) => (shown === mediaId ? null : shown)), 2_600);
      }
    };
    void followPreparation({
      mediaId,
      askNow: playback.ask,
      fetchItem,
      askPlayable,
      onItem: learn,
      onAnswer: (answer) => {
        if (!item.video) return;
        if (answer.status === "ready") learn({ ...item, video: { ...item.video, converted: answer.url, conversion: "done" } });
        else if (answer.status === "failed") onChanged({ ...item, video: { ...item.video, conversion: "failed", conversionFailure: answer.reason } });
      },
      onGone: () => onGone(item),
      wait: abortableWait,
      signal: controller.signal,
    });
    return () => controller.abort();
    // While this moment is being prepared.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, playback?.kind]);
  return { readyChip };
}
