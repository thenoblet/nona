import { describe, expect, it } from "vitest";
import { createSlideClock, playlistReducer, startPlaylist, viewPlaylist, wrapIndex, type Playlist, type Slide } from "./playlist";

const slide = (id: string): Slide => ({
  id,
  src: `/media/${id}.jpg`,
  alt: `Photo ${id}`,
  kind: "photo",
  by: "[Guest]",
  detail: "Reception · just now",
});

const slides = (...ids: string[]) => ids.map(slide);

/** Applies actions in order, like the component dispatching them. */
function run(playlist: Playlist, ...actions: Parameters<typeof playlistReducer>[1][]) {
  return actions.reduce(playlistReducer, playlist);
}

const currentId = (playlist: Playlist) => viewPlaylist(playlist).current?.id ?? null;
const nextId = (playlist: Playlist) => viewPlaylist(playlist).next?.id ?? null;

describe("wrapIndex", () => {
  it("wraps forwards and backwards around the list", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(7, 3)).toBe(1);
    expect(wrapIndex(1, 3)).toBe(1);
  });

  it("is 0 for an empty list", () => {
    expect(wrapIndex(5, 0)).toBe(0);
  });
});

describe("startPlaylist", () => {
  it("starts on the newest slide, playing, with the next one queued", () => {
    const playlist = startPlaylist(slides("a", "b", "c"));
    expect(currentId(playlist)).toBe("a");
    expect(nextId(playlist)).toBe("b");
    expect(playlist.paused).toBe(false);
  });

  it("has nothing to show for an empty list", () => {
    const view = viewPlaylist(startPlaylist([]));
    expect(view.current).toBeNull();
    expect(view.next).toBeNull();
  });

  it("has no next slide when there is only one", () => {
    expect(nextId(startPlaylist(slides("a")))).toBeNull();
  });
});

describe("stepping", () => {
  it("goes forward and back, wrapping at both ends", () => {
    const playlist = startPlaylist(slides("a", "b", "c"));
    expect(currentId(run(playlist, { type: "step", step: 1 }))).toBe("b");
    expect(currentId(run(playlist, { type: "step", step: -1 }))).toBe("c");
    expect(currentId(run(playlist, { type: "step", step: 1 }, { type: "step", step: 1 }, { type: "step", step: 1 }))).toBe("a");
  });

  it("slides in from the side it came from, and keeps the old slide underneath while it does", () => {
    const forward = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: 1 });
    expect(forward.entrance).toBe("forward");
    expect(viewPlaylist(forward).previous?.id).toBe("a");
    expect(run(forward, { type: "step", step: -1 }).entrance).toBe("back");
  });

  it("does nothing with a single slide", () => {
    const playlist = startPlaylist(slides("a"));
    expect(run(playlist, { type: "step", step: 1 })).toBe(playlist);
  });
});

describe("the timer", () => {
  it("cross-fades to the next slide once its photo has loaded", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "loaded", id: "b" }, { type: "tick" });
    expect(currentId(playlist)).toBe("b");
    expect(playlist.entrance).toBe("fade");
  });

  it("waits on the current photo while the next is still loading, then moves when it arrives", () => {
    const waiting = run(startPlaylist(slides("a", "b", "c")), { type: "tick" });
    expect(currentId(waiting)).toBe("a");
    expect(waiting.due).toBe(true);

    const moved = run(waiting, { type: "loaded", id: "b" });
    expect(currentId(moved)).toBe("b");
    expect(moved.due).toBe(false);
  });

  it("does not move while paused, even when the next photo arrives", () => {
    const paused = run(startPlaylist(slides("a", "b")), { type: "toggle-pause" });
    expect(paused.paused).toBe(true);
    expect(currentId(run(paused, { type: "loaded", id: "b" }, { type: "tick" }))).toBe("a");
  });

  it("forgets a pending move when paused", () => {
    const playlist = run(startPlaylist(slides("a", "b")), { type: "tick" }, { type: "toggle-pause" }, { type: "toggle-pause" });
    expect(playlist.due).toBe(false);
    expect(currentId(run(playlist, { type: "loaded", id: "b" }))).toBe("a");
  });

  it("still lets the guest step by hand while paused", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "toggle-pause" }, { type: "step", step: 1 });
    expect(currentId(playlist)).toBe("b");
    expect(playlist.paused).toBe(true);
  });
});

describe("a photo that fails to load", () => {
  it("is skipped when it is next, and the one after it is queued instead", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "failed", id: "b" });
    expect(currentId(playlist)).toBe("a");
    expect(nextId(playlist)).toBe("c");
    expect(currentId(run(playlist, { type: "step", step: 1 }))).toBe("c");
  });

  it("is replaced by the following slide when it is showing", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: 1 }, { type: "failed", id: "b" });
    expect(currentId(playlist)).toBe("c");
    expect(playlist.entrance).toBe("fade");
  });

  it("wraps to the first slide when the last one fails while showing", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: -1 }, { type: "failed", id: "c" });
    expect(currentId(playlist)).toBe("a");
  });

  it("is never shown again until the next refresh", () => {
    let playlist = run(startPlaylist(slides("a", "b", "c")), { type: "failed", id: "b" });
    const seen = new Set<string>();
    for (let stepCount = 0; stepCount < 10; stepCount++) {
      playlist = run(playlist, { type: "step", step: 1 });
      seen.add(currentId(playlist) ?? "");
    }
    expect([...seen].sort()).toEqual(["a", "c"]);
  });

  it("keeps the slideshow going while the timer waits on it", () => {
    const waiting = run(startPlaylist(slides("a", "b", "c")), { type: "tick" }, { type: "failed", id: "b" });
    expect(waiting.due).toBe(true);
    expect(currentId(run(waiting, { type: "loaded", id: "c" }))).toBe("c");
  });

  it("moves on at once when a waited-for photo fails and the one after it has already loaded", () => {
    // Two photos playing; a refresh queues a new one, b, after the current photo.
    let playlist = run(startPlaylist(slides("a", "c")), { type: "loaded", id: "a" }, { type: "loaded", id: "c" });
    playlist = run(playlist, { type: "tick" }, { type: "tick" });
    expect(currentId(playlist)).toBe("a");
    playlist = run(playlist, { type: "replaced", slides: slides("a", "b", "c") }, { type: "tick" });
    expect(playlist.due).toBe(true);

    // b never arrives; c, already loaded underneath, is next. No load event will come for it.
    playlist = run(playlist, { type: "failed", id: "b" });
    expect(currentId(playlist)).toBe("c");
    expect(playlist.due).toBe(false);
  });

  it("forgets a pending move when the slide it was for goes away", () => {
    const waiting = run(startPlaylist(slides("a", "b", "c")), { type: "tick" });
    expect(waiting.due).toBe(true);
    const replaced = run(waiting, { type: "failed", id: "a" });
    expect(currentId(replaced)).toBe("b");
    expect(replaced.due).toBe(false);
    const refreshed = run(waiting, { type: "replaced", slides: slides("b", "c") });
    expect(currentId(refreshed)).toBe("b");
    expect(refreshed.due).toBe(false);
  });

  it("leaves nothing to show when every photo fails, without throwing", () => {
    const playlist = run(startPlaylist(slides("a", "b")), { type: "failed", id: "a" }, { type: "failed", id: "b" });
    expect(viewPlaylist(playlist).current).toBeNull();
    expect(run(playlist, { type: "step", step: 1 }, { type: "tick" })).toEqual(playlist);
  });

  it("ignores ids that are not in the list, and repeats", () => {
    const playlist = startPlaylist(slides("a", "b"));
    expect(run(playlist, { type: "failed", id: "zzz" })).toBe(playlist);
    const once = run(playlist, { type: "failed", id: "b" });
    expect(run(once, { type: "failed", id: "b" })).toBe(once);
  });
});

describe("a refresh", () => {
  it("replaces the list and stays on the slide that was showing", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: 1 });
    const refreshed = run(playlist, { type: "replaced", slides: slides("new", "a", "b", "c") });
    expect(refreshed.slides.map((item) => item.id)).toEqual(["new", "a", "b", "c"]);
    expect(currentId(refreshed)).toBe("b");
    expect(nextId(refreshed)).toBe("c");
  });

  it("moves on from a slide that is no longer in the list, to the one now in its place", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: 1 });
    const refreshed = run(playlist, { type: "replaced", slides: slides("a", "c") });
    expect(currentId(refreshed)).toBe("c");
    expect(viewPlaylist(refreshed).previous?.id).toBe("a");
  });

  it("drops a removed slide from underneath the current one too", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c")), { type: "step", step: 1 });
    const refreshed = run(playlist, { type: "replaced", slides: slides("b", "c") });
    expect(refreshed.previousId).toBeNull();
  });

  it("gives failed photos another try", () => {
    const playlist = run(startPlaylist(slides("a", "b")), { type: "failed", id: "b" });
    const refreshed = run(playlist, { type: "replaced", slides: slides("a", "b") });
    expect(refreshed.failed.size).toBe(0);
    expect(nextId(refreshed)).toBe("b");
  });

  it("moves on at once when it was waiting and the refreshed list's next photo is already loaded", () => {
    // On a, with c loaded underneath; the timer is waiting on b, which the refresh removes.
    let playlist = run(startPlaylist(slides("a", "c")), { type: "loaded", id: "a" }, { type: "loaded", id: "c" });
    playlist = run(playlist, { type: "tick" }, { type: "tick" });
    playlist = run(playlist, { type: "replaced", slides: slides("a", "b", "c") }, { type: "tick" });
    expect(playlist.due).toBe(true);
    const refreshed = run(playlist, { type: "replaced", slides: slides("a", "c") });
    expect(currentId(refreshed)).toBe("c");
    expect(refreshed.due).toBe(false);
  });

  it("starts showing photos when the first ones arrive", () => {
    const refreshed = run(startPlaylist([]), { type: "replaced", slides: slides("a", "b") });
    expect(currentId(refreshed)).toBe("a");
  });

  it("empties the screen when the list comes back empty", () => {
    const refreshed = run(startPlaylist(slides("a", "b")), { type: "replaced", slides: [] });
    expect(viewPlaylist(refreshed).current).toBeNull();
  });
});

describe("memory over a long evening", () => {
  it("only remembers loaded photos that are still on screen, and never grows the list", () => {
    let playlist = startPlaylist(slides(...Array.from({ length: 50 }, (_value, index) => `photo-${index}`)));
    for (let stepCount = 0; stepCount < 500; stepCount++) {
      const upcoming = nextId(playlist);
      if (upcoming) playlist = run(playlist, { type: "loaded", id: upcoming });
      playlist = run(playlist, { type: "tick" });
      if (stepCount % 30 === 0) playlist = run(playlist, { type: "replaced", slides: playlist.slides.slice() });
    }
    expect(playlist.loaded.size).toBeLessThanOrEqual(3);
    expect(playlist.failed.size).toBe(0);
    expect(playlist.slides).toHaveLength(50);
  });

  it("ignores a load from a slide that has already left the screen", () => {
    const playlist = run(startPlaylist(slides("a", "b", "c", "d")), { type: "loaded", id: "d" });
    expect(playlist.loaded.has("d")).toBe(false);
  });
});

describe("two slides", () => {
  it("keeps the other slide underneath rather than also queueing it as next", () => {
    const playlist = run(startPlaylist(slides("a", "b")), { type: "step", step: 1 });
    const view = viewPlaylist(playlist);
    expect(view.current?.id).toBe("b");
    expect(view.previous?.id).toBe("a");
    expect(view.next?.id).toBe("a");
    expect(view.layers.map((layer) => [layer.slide.id, layer.role])).toEqual([
      ["a", "previous"],
      ["b", "current"],
    ]);
  });
});

describe("createSlideClock", () => {
  it("gives each new slide its full time", () => {
    let time = 0;
    const clock = createSlideClock(6000, () => time);
    expect(clock.start("a")).toBe(6000);
    time = 6000;
    clock.stop();
    expect(clock.start("b")).toBe(6000);
  });

  it("carries on after a pause where it stopped", () => {
    let time = 0;
    const clock = createSlideClock(6000, () => time);
    clock.start("a");
    time = 4000;
    clock.stop();
    time = 60_000;
    expect(clock.start("a")).toBe(2000);
  });

  it("never asks for a negative wait", () => {
    let time = 0;
    const clock = createSlideClock(6000, () => time);
    clock.start("a");
    time = 9000;
    clock.stop();
    expect(clock.start("a")).toBe(0);
  });
});
