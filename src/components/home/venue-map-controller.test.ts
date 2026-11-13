import { afterEach, describe, expect, it, vi } from "vitest";
import type { GoogleMapsLibraries } from "./google-maps";
import { TILES_TIMEOUT_MILLISECONDS, VenueMapController, type VenueMapStatus } from "./venue-map-controller";

/** A promise the test settles when it chooses. */
function deferred<TValue>() {
  let resolve: (value: TValue) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<TValue>((resolveWith, rejectWith) => {
    resolve = resolveWith;
    reject = rejectWith;
  });
  return { promise, resolve, reject };
}

const libraries = {} as GoogleMapsLibraries;

/** Lets every settled promise run its callbacks, with real or fake timers. */
async function settle() {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

/** Google and the page as the controller sees them, with every call recorded. */
function fakeGoogle({ refusedAlready = false } = {}) {
  const statuses: VenueMapStatus[] = [];
  const refusalListeners = new Set<() => void>();
  const drawn: { placesKey: string; preview: boolean; onReady: () => void; previews: boolean[]; takenDown: boolean }[] = [];
  let load = deferred<GoogleMapsLibraries>();
  let maxZoom = deferred<number>();
  const services = {
    load: vi.fn(() => load.promise),
    maxZoom: vi.fn(() => maxZoom.promise),
    draw: vi.fn(({ placesKey, preview, onReady }: { placesKey: string; preview: boolean; onReady: () => void }) => {
      const map = { placesKey, preview, onReady, previews: [] as boolean[], takenDown: false };
      drawn.push(map);
      return {
        setPreview: (next: boolean) => map.previews.push(next),
        takeDown: () => {
          map.takenDown = true;
        },
      };
    }),
    keyRefused: () => refusedAlready,
    onKeyRefused: (listener: () => void) => {
      refusalListeners.add(listener);
      return () => {
        refusalListeners.delete(listener);
      };
    },
    onStatus: (status: VenueMapStatus) => statuses.push(status),
  };
  return {
    services,
    statuses,
    drawn,
    /** Google's script and libraries arrive, then its answer on the imagery's zoom. */
    async answer() {
      load.resolve(libraries);
      maxZoom.resolve(20);
      await settle();
      expect(services.draw).toHaveBeenCalled();
    },
    loadFails() {
      load.reject(new Error("The Google Maps script didn't load"));
    },
    refuseKey() {
      for (const listener of refusalListeners) listener();
    },
    resolveLoad: () => load.resolve(libraries),
    resolveMaxZoom: () => maxZoom.resolve(20),
    reset() {
      load = deferred();
      maxZoom = deferred();
    },
  };
}


afterEach(() => {
  vi.useRealTimers();
});

describe("VenueMapController", () => {
  it("draws one map however often /home is hidden and shown again, as a client-side return to it does", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    google.drawn[0].onReady();
    expect(google.statuses).toEqual(["ready"]);

    for (let round = 0; round < 2; round += 1) {
      controller.hide();
      controller.show("places", false);
      await settle();
    }
    expect(google.services.draw).toHaveBeenCalledTimes(1);
    expect(google.services.load).toHaveBeenCalledTimes(1);
    expect(google.drawn[0].takenDown).toBe(false);
  });

  it("draws nothing for a frame hidden while Google loads, and draws once when it is shown again", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    controller.hide();
    google.resolveLoad();
    google.resolveMaxZoom();
    await settle();
    expect(google.services.draw).not.toHaveBeenCalled();

    controller.show("places", false);
    await settle();
    expect(google.services.draw).toHaveBeenCalledTimes(1);
    controller.hide();
    controller.show("places", false);
    await settle();
    expect(google.services.draw).toHaveBeenCalledTimes(1);
  });

  it("draws no map when Google refuses the key while the imagery's zoom is being asked for", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    google.resolveLoad();
    await settle();
    google.refuseKey();
    google.resolveMaxZoom();
    await settle();
    expect(google.services.draw).not.toHaveBeenCalled();
    expect(google.statuses).toEqual(["failed"]);
  });

  it("after a failure, loads and draws nothing more, whenever it is shown again", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    google.loadFails();
    await settle();
    expect(google.statuses).toEqual(["failed"]);

    google.reset();
    controller.hide();
    controller.show("places", false);
    google.resolveLoad();
    google.resolveMaxZoom();
    await settle();
    expect(google.services.load).toHaveBeenCalledTimes(1);
    expect(google.services.draw).not.toHaveBeenCalled();
  });

  it("takes the map down when Google refuses the key after drawing it, and notices a refusal that came while hidden", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    google.refuseKey();
    expect(google.drawn[0].takenDown).toBe(true);
    expect(google.statuses).toEqual(["failed"]);

    const later = fakeGoogle({ refusedAlready: true });
    new VenueMapController(later.services).show("places", false);
    await settle();
    expect(later.services.load).not.toHaveBeenCalled();
    expect(later.statuses).toEqual(["failed"]);
  });

  it("gives up on a map whose first tiles don't arrive within 10 seconds, taking it down", async () => {
    vi.useFakeTimers();
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    await vi.advanceTimersByTimeAsync(TILES_TIMEOUT_MILLISECONDS - 1);
    expect(google.statuses).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(google.statuses).toEqual(["failed"]);
    expect(google.drawn[0].takenDown).toBe(true);
    // A tile that turns up after all changes nothing.
    google.drawn[0].onReady();
    expect(google.statuses).toEqual(["failed"]);
  });

  it("keeps a map whose tiles arrive in time, with no timer left behind", async () => {
    vi.useFakeTimers();
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    await vi.advanceTimersByTimeAsync(4_000);
    google.drawn[0].onReady();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TILES_TIMEOUT_MILLISECONDS * 2);
    expect(google.statuses).toEqual(["ready"]);
    expect(google.drawn[0].takenDown).toBe(false);
  });

  it("pauses the tiles' deadline while hidden, and gives the map its full time again when shown", async () => {
    vi.useFakeTimers();
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    await vi.advanceTimersByTimeAsync(8_000);
    controller.hide();
    await vi.advanceTimersByTimeAsync(TILES_TIMEOUT_MILLISECONDS * 3);
    expect(google.statuses).toEqual([]);
    controller.show("places", false);
    await vi.advanceTimersByTimeAsync(TILES_TIMEOUT_MILLISECONDS - 1);
    expect(google.statuses).toEqual([]);
    google.drawn[0].onReady();
    expect(google.statuses).toEqual(["ready"]);
    expect(google.services.draw).toHaveBeenCalledTimes(1);
  });

  it("switches a drawn map between phone and computer in place, without drawing another", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    controller.hide();
    controller.show("places", true);
    controller.hide();
    controller.show("places", false);
    expect(google.services.draw).toHaveBeenCalledTimes(1);
    expect(google.drawn[0].previews).toEqual([true, false]);
  });

  it("draws the map again, taking the old one down, only when the places change", async () => {
    const google = fakeGoogle();
    const controller = new VenueMapController(google.services);
    controller.show("places", false);
    await google.answer();
    controller.hide();
    controller.show("moved places", false);
    await settle();
    expect(google.services.draw).toHaveBeenCalledTimes(2);
    expect(google.drawn[0].takenDown).toBe(true);
    expect(google.drawn[1].placesKey).toBe("moved places");
    expect(google.services.load).toHaveBeenCalledTimes(2);
  });
});
