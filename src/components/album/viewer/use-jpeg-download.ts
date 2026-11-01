"use client";

import { useEffect, useRef, useState } from "react";
import { downloadLink } from "../album-client";
import { abortableWait, waitForLink } from "./save";

/*
 * "As JPEG" (gate B 1b): the first request makes an iPhone photo's JPEG, so the menu's row says
 * "Making the JPEG…" and the viewer asks after it every few seconds, for at most two minutes, then
 * downloads it. Moving on or closing the viewer stops asking (fix round 1, Minor #1): nothing
 * downloads after the guest has gone.
 */
export function useJpegDownload(say: (text: string, lingerMilliseconds?: number) => void) {
  /** The moment whose JPEG is being made, or null. */
  const [making, setMaking] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  /** Stops asking (the guest moved on). */
  function stop(): void {
    controller.current?.abort();
    controller.current = null;
    setMaking(null);
  }

  /** Asks until the moment's JPEG is made, then calls `onReady` (which downloads it). */
  async function start(mediaId: string, onReady: () => void): Promise<void> {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    setMaking(mediaId);
    const link = await waitForLink(mediaId, "jpeg", { downloadLink, wait: abortableWait, signal: own.signal });
    if (link.status === "stopped" || own.signal.aborted) return;
    controller.current = null;
    setMaking(null);
    if (link.status === "ready") onReady();
    else say("We couldn't make the JPEG just now. Download the original instead.", 6_000);
  }

  return { making, start, stop };
}
