import { describe, expect, it } from "vitest";
import { createPageGuard, type GuardDocument, type GuardWindow, type WakeLockLike } from "./page-guard";

/*
 * What keeps an upload going while it can (Ruling BE): the screen kept awake while files send
 * (released once none do, asked for again when the page comes back into view), and a warning if
 * the guest tries to leave mid-upload. A browser can't send after the page closes.
 */

class FakeWakeLock implements WakeLockLike {
  readonly requests: string[] = [];
  readonly held: { released: boolean; listeners: (() => void)[] }[] = [];
  refuse = false;
  async request(type: "screen") {
    this.requests.push(type);
    if (this.refuse) throw new DOMException("Not allowed", "NotAllowedError");
    const sentinel = {
      released: false,
      listeners: [] as (() => void)[],
      async release() {
        sentinel.released = true;
        for (const listener of sentinel.listeners) listener();
      },
      addEventListener(_type: "release", listener: () => void) {
        sentinel.listeners.push(listener);
      },
    };
    this.held.push(sentinel);
    return sentinel;
  }
  /** What a browser does when the page goes out of view: lets the lock go. */
  dropAll() {
    for (const sentinel of this.held) {
      if (sentinel.released) continue;
      sentinel.released = true;
      for (const listener of sentinel.listeners) listener();
    }
  }
  heldNow() {
    return this.held.filter((sentinel) => !sentinel.released).length;
  }
}

class FakeDocument implements GuardDocument {
  visibilityState: DocumentVisibilityState = "visible";
  readonly #listeners: (() => void)[] = [];
  addEventListener(_type: "visibilitychange", listener: () => void) {
    this.#listeners.push(listener);
  }
  show(state: DocumentVisibilityState) {
    this.visibilityState = state;
    for (const listener of this.#listeners) listener();
  }
}

class FakeWindow implements GuardWindow {
  readonly listeners = new Set<(event: BeforeUnloadEvent) => void>();
  addEventListener(_type: "beforeunload", listener: (event: BeforeUnloadEvent) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "beforeunload", listener: (event: BeforeUnloadEvent) => void) {
    this.listeners.delete(listener);
  }
  /** The guest tries to leave: whether the page asked the browser to check with them. */
  leave(): boolean {
    let asked = false;
    const event = { preventDefault: () => (asked = true), returnValue: undefined as unknown } as unknown as BeforeUnloadEvent;
    for (const listener of this.listeners) listener(event);
    return asked || (event as unknown as { returnValue: unknown }).returnValue === "";
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setUp() {
  const wakeLock = new FakeWakeLock();
  const document = new FakeDocument();
  const window = new FakeWindow();
  const guard = createPageGuard({ wakeLock, document, window });
  return { wakeLock, document, window, guard };
}

describe("the screen while files send", () => {
  it("is kept awake while any upload is in flight, and let go once none is", async () => {
    const { wakeLock, guard } = setUp();
    guard.update(true);
    guard.update(true);
    await settle();
    expect(wakeLock.requests).toEqual(["screen"]);
    expect(wakeLock.heldNow()).toBe(1);

    guard.update(false);
    await settle();
    expect(wakeLock.heldNow()).toBe(0);
  });

  it("is asked for again when the page comes back into view, as browsers let it go when it hides", async () => {
    const { wakeLock, document, guard } = setUp();
    guard.update(true);
    await settle();
    document.show("hidden");
    wakeLock.dropAll();
    await settle();
    expect(wakeLock.requests).toHaveLength(1);

    document.show("visible");
    await settle();
    expect(wakeLock.requests).toHaveLength(2);
    expect(wakeLock.heldNow()).toBe(1);

    // Not once the uploads are done.
    guard.update(false);
    document.show("hidden");
    document.show("visible");
    await settle();
    expect(wakeLock.requests).toHaveLength(2);
  });

  it("lets go of a lock that arrives after the uploads have finished", async () => {
    const { wakeLock, guard } = setUp();
    guard.update(true);
    guard.update(false);
    await settle();
    expect(wakeLock.heldNow()).toBe(0);
  });

  it("never throws where the browser has no wake lock, or refuses it", async () => {
    const refusing = new FakeWakeLock();
    refusing.refuse = true;
    const document = new FakeDocument();
    const window = new FakeWindow();
    for (const wakeLock of [refusing, null, { request: () => { throw new TypeError("not supported"); } }]) {
      const guard = createPageGuard({ wakeLock, document, window });
      expect(() => guard.update(true)).not.toThrow();
      await settle();
      expect(() => guard.update(false)).not.toThrow();
    }
  });
});

describe("leaving mid-upload", () => {
  it("asks the browser to check with the guest only while files are sending", () => {
    const { window, guard } = setUp();
    expect(window.leave()).toBe(false);
    guard.update(true);
    expect(window.leave()).toBe(true);
    guard.update(false);
    expect(window.leave()).toBe(false);
    expect(window.listeners.size).toBe(0);
  });
});
