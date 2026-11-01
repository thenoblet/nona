/*
 * What keeps an upload going while it can (Ruling BE). A browser can't send once its page closes,
 * so while files are on their way:
 * - the screen is kept awake (Screen Wake Lock), so a phone left on the table doesn't lock and
 *   pause the upload; browsers let the lock go when the page hides, so it is asked for again when
 *   the page comes back into view. No permission prompt is involved, and where the browser has no
 *   wake lock, or refuses it, nothing happens;
 * - leaving the page asks first (beforeunload), where the browser honours that.
 * Both are let go once nothing is sending. It ships with the uploader.
 */

/** The parts of a wake lock this uses: the browser's navigator.wakeLock. */
export type WakeLockLike = {
  request(type: "screen"): Promise<{ release(): Promise<void>; addEventListener?(type: "release", listener: () => void): void }>;
};

export type GuardDocument = {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
};

export type GuardWindow = {
  addEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
  removeEventListener(type: "beforeunload", listener: (event: BeforeUnloadEvent) => void): void;
};

export type PageGuard = {
  /** Whether any file is on its way. */
  update(busy: boolean): void;
};

type WakeLockSentinelLike = Awaited<ReturnType<WakeLockLike["request"]>>;

export function createPageGuard(environment: {
  wakeLock: WakeLockLike | null | undefined;
  document: GuardDocument | null | undefined;
  window: GuardWindow | null | undefined;
}): PageGuard {
  const { wakeLock, document, window } = environment;
  let busy = false;
  let held: WakeLockSentinelLike | null = null;
  let asking = false;

  // A guest leaving mid-upload is asked first; the browser words the question itself.
  const askBeforeLeaving = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    // Older browsers ask only when this is set.
    event.returnValue = "";
  };

  function keepAwake(): void {
    if (!wakeLock || held || asking || document?.visibilityState === "hidden") return;
    asking = true;
    try {
      wakeLock.request("screen").then(
        (sentinel) => {
          asking = false;
          // The uploads finished while it was asked for: let it go at once.
          if (!busy) {
            sentinel.release().catch(() => {});
            return;
          }
          held = sentinel;
          sentinel.addEventListener?.("release", () => {
            if (held === sentinel) held = null;
          });
        },
        () => {
          asking = false;
        },
      );
    } catch {
      // No wake lock here after all.
      asking = false;
    }
  }

  function letSleep(): void {
    const sentinel = held;
    held = null;
    sentinel?.release().catch(() => {});
  }

  document?.addEventListener("visibilitychange", () => {
    if (busy && document.visibilityState === "visible") keepAwake();
  });

  return {
    update(nowBusy) {
      if (nowBusy === busy) return;
      busy = nowBusy;
      if (busy) {
        window?.addEventListener("beforeunload", askBeforeLeaving);
        keepAwake();
      } else {
        window?.removeEventListener("beforeunload", askBeforeLeaving);
        letSleep();
      }
    },
  };
}

/** The page's own guard: the browser's wake lock, document and window, where there are any. */
export function browserPageGuard(): PageGuard {
  if (typeof window === "undefined") return { update: () => {} };
  const navigatorWithLock = navigator as Navigator & { wakeLock?: WakeLockLike };
  return createPageGuard({ wakeLock: navigatorWithLock.wakeLock ?? null, document, window });
}
