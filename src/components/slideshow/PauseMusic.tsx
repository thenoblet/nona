"use client";

import { useEffect } from "react";
import { useMusic } from "@/components/music/MusicProvider";

/**
 * The slideshow has no music player, so music carried over from the album
 * (it lives in the root layout) is paused here rather than left running with no controls.
 */
export function PauseMusic() {
  const { playing, toggle } = useMusic();
  useEffect(() => {
    if (playing) toggle();
  }, [playing, toggle]);
  return null;
}
