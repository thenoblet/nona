/*
 * Loads the uploader (engine.ts, with Uppy) apart from the album page, so the page first loads
 * without it: prefetched once the page is idle, and loaded for certain on the first pick. After a
 * deploy, the page a guest still has open may name an uploader chunk the server no longer has; the
 * page then reloads once, never in a loop, to pick up the new one.
 */

type EngineModule = typeof import("./engine");

let loading: Promise<EngineModule> | null = null;

/** The uploader module, loaded once; a failed load is tried again on the next call. */
export function loadEngine(): Promise<EngineModule> {
  loading ??= import("./engine").catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

/** Whether `error` is a script chunk that couldn't be loaded (Turbopack's, or the browser's words for an import()). */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ChunkLoadError") return true;
  return /Failed to load chunk|Loading chunk .* failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message,
  );
}

export type SessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const RELOADED_AT_KEY = "nona:uploader-reloaded-at";
/** No second reload within this long of the first: a chunk still missing after one isn't a deploy. */
const RELOAD_GUARD_MILLISECONDS = 10 * 60 * 1000;

/**
 * Reloads the page, unless it reloaded for this within the last ten minutes, or can't remember
 * doing so (no session storage): either could loop. True when it reloads.
 */
export function reloadOnceAfterChunkError({
  storage,
  reload,
  now,
}: {
  storage: SessionStorageLike | null;
  reload: () => void;
  now: number;
}): boolean {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOADED_AT_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_GUARD_MILLISECONDS) return false;
    storage.setItem(RELOADED_AT_KEY, String(now));
  } catch {
    return false;
  }
  reload();
  return true;
}

function sessionStorageOrNull(): SessionStorageLike | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * The uploader for a pick. A chunk a deploy removed reloads the page once (the pick is lost, and
 * the guest picks again on the fresh page); the promise then never settles, as the page is going.
 */
export async function loadEngineForPick(): Promise<EngineModule> {
  try {
    return await loadEngine();
  } catch (error) {
    if (isChunkLoadError(error) && reloadOnceAfterChunkError({ storage: sessionStorageOrNull(), reload: () => window.location.reload(), now: Date.now() })) {
      return new Promise<EngineModule>(() => {});
    }
    throw error;
  }
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Fetches the uploader once the page is idle, so the first pick doesn't wait for it, unless the
 * phone asked to save data. A failure here is quiet: the pick loads it again. Returns a cancel.
 */
export function prefetchEngineWhenIdle(): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  const idleWindow = window as IdleWindow;
  const prefetch = () => {
    loadEngine().catch(() => {});
  };
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(prefetch, { timeout: 5_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  // Safari has no requestIdleCallback: a moment after load is idle enough.
  const timer = window.setTimeout(prefetch, 2_000);
  return () => window.clearTimeout(timer);
}
