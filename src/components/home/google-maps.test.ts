import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleMapsScriptUrl, withTimeout } from "./google-maps";

describe("googleMapsScriptUrl", () => {
  it("asks for the Maps JavaScript API with the key, loaded asynchronously, calling back when ready", () => {
    const url = new URL(googleMapsScriptUrl("browser-key", "whenReady"));
    expect(url.origin + url.pathname).toBe("https://maps.googleapis.com/maps/api/js");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      key: "browser-key",
      v: "weekly",
      loading: "async",
      callback: "whenReady",
    });
  });

  it("encodes the key", () => {
    expect(googleMapsScriptUrl("a key&more", "whenReady")).toContain("key=a+key%26more&");
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the answer when it comes in time", async () => {
    await expect(withTimeout(Promise.resolve("map"), 10_000, "too slow")).resolves.toBe("map");
  });

  it("passes the failure on when it fails in time", async () => {
    await expect(withTimeout(Promise.reject(new Error("refused")), 10_000, "too slow")).rejects.toThrow("refused");
  });

  it("gives up once the time is spent", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    let settled = false;
    const answer = withTimeout(never, 10_000, "The map took too long").finally(() => {
      settled = true;
    });
    answer.catch(() => {});
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).rejects.toThrow("The map took too long");
  });

  it("leaves no timer behind once the answer is in", async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve("map"), 10_000, "too slow");
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** A script tag that never touches the network: the test says whether it loaded or failed. */
type FakeScript = { src: string; async: boolean; removed: boolean; fail: () => void };

/**
 * The browser as the loader sees it: a window, a document head that collects script tags, and
 * the `google.maps` Google's script would define. Each test gets a fresh copy of the loader.
 */
function fakeBrowser() {
  const page: { nonaGoogleMapsReady?: () => void; gm_authFailure?: () => void } = {};
  const scripts: FakeScript[] = [];
  vi.stubGlobal("window", page);
  vi.stubGlobal("document", {
    createElement: () => {
      const errorHandlers: (() => void)[] = [];
      const script = {
        src: "",
        async: false,
        removed: false,
        addEventListener: (type: string, handler: () => void) => {
          if (type === "error") errorHandlers.push(handler);
        },
        remove: () => {
          script.removed = true;
        },
        fail: () => {
          for (const handler of errorHandlers) handler();
        },
      };
      return script;
    },
    head: { append: (script: FakeScript) => scripts.push(script) },
  });
  vi.stubGlobal("google", { maps: { importLibrary: async (name: string) => ({ library: name }) } });
  return { page, scripts };
}

describe("loadGoogleMaps", () => {
  let loader: typeof import("./google-maps");

  beforeEach(async () => {
    vi.resetModules();
    loader = await import("./google-maps");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("adds one script with the key and gives the map and core libraries once Google calls back", async () => {
    const { page, scripts } = fakeBrowser();
    const first = loader.loadGoogleMaps("browser-key");
    const second = loader.loadGoogleMaps("browser-key");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].async).toBe(true);
    expect(new URL(scripts[0].src).searchParams.get("key")).toBe("browser-key");
    expect(new URL(scripts[0].src).searchParams.get("callback")).toBe("nonaGoogleMapsReady");

    page.nonaGoogleMapsReady?.();
    const libraries = { maps: { library: "maps" }, core: { library: "core" } };
    await expect(first).resolves.toEqual(libraries);
    await expect(second).resolves.toEqual(libraries);
  });

  it("fails when the script can't load, and lets the next visit try again", async () => {
    const { page, scripts } = fakeBrowser();
    const failed = loader.loadGoogleMaps("browser-key");
    scripts[0].fail();
    await expect(failed).rejects.toThrow("The Google Maps script didn't load");
    expect(scripts[0].removed).toBe(true);

    const retried = loader.loadGoogleMaps("browser-key");
    expect(scripts).toHaveLength(2);
    page.nonaGoogleMapsReady?.();
    await expect(retried).resolves.toBeDefined();
  });

  it("gives up after 10 seconds without Google's answer", async () => {
    vi.useFakeTimers();
    fakeBrowser();
    const slow = loader.loadGoogleMaps("browser-key");
    slow.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(slow).rejects.toThrow("Google Maps took too long to load");
  });

  it("tells the listeners when Google refuses the key (billing, another site, over the cap), and loads nothing after", async () => {
    const { page, scripts } = fakeBrowser();
    const loaded = loader.loadGoogleMaps("browser-key");
    page.nonaGoogleMapsReady?.();
    await loaded;

    const refused = vi.fn();
    const stoppedListening = vi.fn();
    loader.onGoogleMapsKeyRefused(refused);
    loader.onGoogleMapsKeyRefused(stoppedListening)();
    page.gm_authFailure?.();

    expect(refused).toHaveBeenCalledOnce();
    expect(stoppedListening).not.toHaveBeenCalled();
    await expect(loader.loadGoogleMaps("browser-key")).rejects.toThrow("Google Maps refused the key");
    expect(scripts).toHaveLength(1);
  });
});
