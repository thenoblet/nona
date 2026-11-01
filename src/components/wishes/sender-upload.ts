import type { Engine } from "@/components/album/uploader/engine";

/*
 * The sending card's hold on the upload client (fix round 2, N2): loaded once, started on the card's
 * store, and let go with the card. A card that goes while the client is still loading (a guest who
 * navigates away on a slow connection) never has an engine started after it: none uploads unseen,
 * none keeps the page's leave warning or wake lock, and none is left holding the recording.
 */

/** How a begin ended: started (or already), the card went first, or the client didn't load (try again). */
export type BeginOutcome = "started" | "released" | "failed";

export type SenderUpload = {
  /** Loads the upload client once and starts it. A load that failed is tried afresh on the next begin. */
  begin(): Promise<BeginOutcome>;
  /** The card has gone: the engine, if one started, is destroyed; one still loading is never started. */
  release(): void;
  /** The engine, once started and until released. */
  engine(): Engine | null;
};

/** `load` resolves to what makes and returns the engine, so nothing is made until the card is known to be there. */
export function createSenderUpload(load: () => Promise<() => Engine>): SenderUpload {
  let engine: Engine | null = null;
  let loading: Promise<BeginOutcome> | null = null;
  let released = false;
  return {
    begin() {
      if (released) return Promise.resolve("released");
      if (engine) return Promise.resolve("started");
      loading ??= load().then(
        (make) => {
          if (released) return "released";
          engine ??= make();
          engine.pump();
          return "started";
        },
        () => {
          loading = null;
          return released ? "released" : "failed";
        },
      );
      return loading;
    },
    release() {
      released = true;
      engine?.destroy();
      engine = null;
    },
    engine: () => engine,
  };
}
