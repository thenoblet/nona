import { describe, expect, it } from "vitest";
import type { Engine } from "@/components/album/uploader/engine";
import { createSenderUpload } from "./sender-upload";

/*
 * Fix round 2, N2: the sending card's upload client is started only while the card is there, and
 * let go with it.
 */

function fakeEngine() {
  const calls: string[] = [];
  const engine = {
    pump: () => void calls.push("pump"),
    destroy: () => void calls.push("destroy"),
    retry: () => {},
    cancel: () => {},
    dismiss: () => {},
    replayPendingCancels: async () => {},
  } satisfies Engine;
  return { engine, calls };
}

/** A load the test settles when it chooses, counting the engines it makes. */
function controlledLoad() {
  const made: ReturnType<typeof fakeEngine>[] = [];
  let settle: (outcome: "loads" | "fails") => void = () => {};
  const load = () =>
    new Promise<() => Engine>((resolve, reject) => {
      settle = (outcome) =>
        outcome === "loads"
          ? resolve(() => {
              const next = fakeEngine();
              made.push(next);
              return next.engine;
            })
          : reject(new Error("Failed to load chunk"));
    });
  return { load, made, settle: (outcome: "loads" | "fails") => settle(outcome) };
}

describe("the sending card's upload client", () => {
  it("never starts an engine once the card has gone while the client was still loading", async () => {
    const { load, made, settle } = controlledLoad();
    const upload = createSenderUpload(load);

    const began = upload.begin();
    upload.release();
    settle("loads");

    expect(await began).toBe("released");
    expect(made).toEqual([]);
    expect(upload.engine()).toBeNull();
  });

  it("starts one engine however often it begins, and destroys it when the card goes", async () => {
    const { load, made, settle } = controlledLoad();
    const upload = createSenderUpload(load);

    const first = upload.begin();
    const second = upload.begin();
    settle("loads");

    expect([await first, await second, await upload.begin()]).toEqual(["started", "started", "started"]);
    expect(made).toHaveLength(1);
    expect(made[0].calls).toEqual(["pump"]);

    upload.release();
    expect(made[0].calls).toEqual(["pump", "destroy"]);
    expect(upload.engine()).toBeNull();
    expect(await upload.begin()).toBe("released");
  });

  it("says a failed load plainly, and loads afresh on the next begin, the card's take as it was", async () => {
    let attempts = 0;
    const engines: ReturnType<typeof fakeEngine>[] = [];
    const upload = createSenderUpload(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Failed to load chunk");
      return () => {
        const next = fakeEngine();
        engines.push(next);
        return next.engine;
      };
    });

    expect(await upload.begin()).toBe("failed");
    expect(await upload.begin()).toBe("started");
    expect(attempts).toBe(2);
    expect(engines).toHaveLength(1);
  });
});
