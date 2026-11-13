/**
 * Google's Maps JavaScript API, loaded in the browser only and only once: one script tag, loaded
 * asynchronously, then the two libraries the venue map uses. The whole load has 10 seconds.
 */

const LOAD_TIMEOUT_MILLISECONDS = 10_000;
const READY_CALLBACK = "nonaGoogleMapsReady";

export type GoogleMapsLibraries = { maps: google.maps.MapsLibrary; core: google.maps.CoreLibrary };

declare global {
  interface Window {
    nonaGoogleMapsReady?: () => void;
    /** Google calls this when it refuses the key: another site, an API it isn't allowed, or over its cap. */
    gm_authFailure?: () => void;
  }
}

/** The script's address. The key is a browser key, restricted by referrer and to this one API. */
export function googleMapsScriptUrl(apiKey: string, callbackName: string): string {
  const query = new URLSearchParams({ key: apiKey, v: "weekly", loading: "async", callback: callbackName });
  return `https://maps.googleapis.com/maps/api/js?${query}`;
}

/** The work's answer, or a failure with `message` once `milliseconds` have passed without one. */
export function withTimeout<TValue>(work: Promise<TValue>, milliseconds: number, message: string): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

let scriptLoad: Promise<void> | undefined;
let keyRefused = false;
const refusalListeners = new Set<() => void>();

function addScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    window.nonaGoogleMapsReady = () => resolve();
    window.gm_authFailure = () => {
      keyRefused = true;
      for (const listener of refusalListeners) listener();
    };
    const script = document.createElement("script");
    script.src = googleMapsScriptUrl(apiKey, READY_CALLBACK);
    script.async = true;
    script.addEventListener("error", () => {
      // A later visit to the map tries again.
      script.remove();
      scriptLoad = undefined;
      reject(new Error("The Google Maps script didn't load"));
    });
    document.head.append(script);
  });
}

/**
 * The map and core libraries. Fails when the script can't load, when Google has already refused
 * the key, or after 10 seconds; a script still loading then carries on, for the next visit.
 */
export function loadGoogleMaps(apiKey: string): Promise<GoogleMapsLibraries> {
  if (keyRefused) return Promise.reject(new Error("Google Maps refused the key"));
  const load = async () => {
    scriptLoad ??= addScript(apiKey);
    await scriptLoad;
    const [maps, core] = await Promise.all([google.maps.importLibrary("maps"), google.maps.importLibrary("core")]);
    return { maps, core };
  };
  return withTimeout(load(), LOAD_TIMEOUT_MILLISECONDS, "Google Maps took too long to load");
}

/** Whether Google has refused the key on this page (it then refuses every map after). */
export function googleMapsKeyRefused(): boolean {
  return keyRefused;
}

/**
 * Calls `listener` if Google refuses the key, which it can do after the script has loaded and the
 * map is drawn. Returns the function that stops listening.
 */
export function onGoogleMapsKeyRefused(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}
