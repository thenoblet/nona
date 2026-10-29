"use client";

import { useEffect } from "react";
import { useMusic } from "./MusicProvider";

/** Starts the music when this page opens (or on the first tap, if the browser insists). */
export function Autoplay() {
  const { requestAutoplay } = useMusic();
  useEffect(() => {
    requestAutoplay();
  }, [requestAutoplay]);
  return null;
}
