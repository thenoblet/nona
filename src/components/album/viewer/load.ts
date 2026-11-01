/*
 * The viewer is its own chunk (global constraints: the viewer is lazy-loaded): the album's first
 * load never carries it. It is fetched once the page is idle, unless the phone asked to save data,
 * and loaded for certain on the first tap of a moment.
 */

type ViewerModule = typeof import("./Viewer");

let loading: Promise<ViewerModule> | null = null;

/** The viewer's module, loaded once; a failed load is tried again on the next call. */
export function loadViewer(): Promise<ViewerModule> {
  loading ??= import("./Viewer").catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/** Fetches the viewer while the page is idle, so the first tap doesn't wait for it. Returns a cancel. */
export function prefetchViewerWhenIdle(): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  const idleWindow = window as IdleWindow;
  const prefetch = () => {
    loadViewer().catch(() => {});
  };
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(prefetch, { timeout: 6_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(prefetch, 2_500);
  return () => window.clearTimeout(timer);
}
