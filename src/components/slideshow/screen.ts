import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/*
 * What the venue TV needs from the browser: the screen kept awake, full screen, the pointer
 * out of the way, and to know when the tab is hidden.
 */

const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};

/** True while the tab is hidden (another tab, the screen off, the laptop lid closed). */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.hidden, () => false);
}

/**
 * Asks the browser to keep the screen awake. The browser drops the lock whenever the tab is
 * hidden, so it is asked again each time the tab comes back, and on a tap or key press in case
 * it was refused before the page was touched. Browsers without the API just sleep as usual.
 */
export function useWakeLock(): void {
  useEffect(() => {
    if (!("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let requesting = false;
    let unmounted = false;

    const request = async () => {
      if (unmounted || requesting || document.visibilityState !== "visible") return;
      if (sentinel && !sentinel.released) return;
      requesting = true;
      try {
        const granted = await navigator.wakeLock.request("screen");
        if (unmounted) void granted.release();
        else sentinel = granted;
      } catch {
        // Refused (battery saver, no permission) or the tab was hidden meanwhile: asked again later.
      } finally {
        requesting = false;
      }
    };
    const onVisibility = () => void request();
    const onInteraction = () => void request();

    void request();
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("pointerdown", onInteraction);
    document.addEventListener("keydown", onInteraction);
    return () => {
      unmounted = true;
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("pointerdown", onInteraction);
      document.removeEventListener("keydown", onInteraction);
      void sentinel?.release().catch(() => {});
    };
  }, []);
}

const subscribeFullscreen = (onChange: () => void) => {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
};
const subscribeNothing = () => () => {};

/** Full screen for the whole page. iPhones don't allow it for pages, so `supported` is false there. */
export function useFullscreen(): { supported: boolean; active: boolean; toggle: () => void } {
  const supported = useSyncExternalStore(subscribeNothing, () => document.fullscreenEnabled === true, () => false);
  const active = useSyncExternalStore(subscribeFullscreen, () => Boolean(document.fullscreenElement), () => false);
  const toggle = useCallback(() => {
    if (!document.fullscreenEnabled) return;
    try {
      const change = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen({ navigationUI: "hide" });
      // Refused (no click or key press behind it): nothing to do, the button stays.
      Promise.resolve(change).catch(() => {});
    } catch {
      // Older browsers throw instead of rejecting.
    }
  }, []);
  return { supported, active, toggle };
}

/**
 * True after `delayMs` without the pointer moving or a key press, to hide the pointer and the
 * TV controls. `wake` starts the count again.
 */
export function useIdle(delayMs: number): { idle: boolean; wake: () => void } {
  const [idle, setIdle] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const wake = useCallback(() => {
    setIdle(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setIdle(true), delayMs);
  }, [delayMs]);

  useEffect(() => {
    timer.current = setTimeout(() => setIdle(true), delayMs);
    return () => clearTimeout(timer.current);
  }, [delayMs]);

  return { idle, wake };
}
