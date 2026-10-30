import type { MediaItem } from "@/lib/data/types";

/*
 * What the slideshow shows and in which order, as plain data with no browser in it, so the
 * venue TV's rules can be tested: skip a photo that fails, keep going when a refresh fails,
 * never hold on to more than the screen needs.
 */

export type Slide = Pick<MediaItem, "id" | "alt" | "position" | "kind"> & {
  src: NonNullable<MediaItem["src"]>;
  by: string;
  /** e.g. "Reception · just now" */
  detail: string;
};

/** How the current slide came in: a cross-fade from the timer, or from the side the guest moved to. */
export type Entrance = "fade" | "forward" | "back";

export type Playlist = {
  /** The latest list from the server, newest first. A refresh replaces it; nothing is ever appended. */
  slides: Slide[];
  /** Slides whose photo failed to load. Skipped until the next refresh gives them another try. */
  failed: ReadonlySet<string>;
  /** Slides on screen (underneath, current, next) whose photo has loaded. */
  loaded: ReadonlySet<string>;
  currentId: string | null;
  /** The slide the current one is fading in over. */
  previousId: string | null;
  /** Where the current slide sat among the playable ones, so a slide that goes away is replaced by its neighbour. */
  position: number;
  entrance: Entrance;
  paused: boolean;
  /** The current slide's time is up, but the next photo is still loading: move as soon as it arrives. */
  due: boolean;
};

export type PlaylistAction =
  /** The guest moved: arrow keys, a swipe, a tap or a button. */
  | { type: "step"; step: 1 | -1 }
  /** The current slide's time is up. */
  | { type: "tick" }
  | { type: "loaded"; id: string }
  | { type: "failed"; id: string }
  | { type: "replaced"; slides: Slide[] }
  | { type: "toggle-pause" };

export type LayerRole = "previous" | "current" | "next";

export type PlaylistView = {
  /** The slides that can be shown, in order. */
  playable: Slide[];
  /** The current slide's place in `playable`. */
  index: number;
  current: Slide | null;
  previous: Slide | null;
  /** The slide after the current one; null when there is only one. */
  next: Slide | null;
  /** What to mount, bottom to top: at most three photos, so only the next one is ever preloaded. */
  layers: { slide: Slide; role: LayerRole }[];
};

export function wrapIndex(index: number, length: number): number {
  if (length === 0) return 0;
  return ((index % length) + length) % length;
}

export function startPlaylist(slides: Slide[]): Playlist {
  return {
    slides,
    failed: new Set(),
    loaded: new Set(),
    currentId: slides[0]?.id ?? null,
    previousId: null,
    position: 0,
    entrance: "fade",
    paused: false,
    due: false,
  };
}

export function viewPlaylist(playlist: Playlist): PlaylistView {
  const playable = playlist.slides.filter((slide) => !playlist.failed.has(slide.id));
  if (playable.length === 0) {
    return { playable, index: 0, current: null, previous: null, next: null, layers: [] };
  }
  const found = playable.findIndex((slide) => slide.id === playlist.currentId);
  const index = found >= 0 ? found : wrapIndex(playlist.position, playable.length);
  const current = playable[index];
  const previous = playable.find((slide) => slide.id === playlist.previousId && slide.id !== current.id) ?? null;
  const following = playable[wrapIndex(index + 1, playable.length)];
  const next = following.id === current.id ? null : following;

  const layers: PlaylistView["layers"] = [];
  if (previous) layers.push({ slide: previous, role: "previous" });
  layers.push({ slide: current, role: "current" });
  // With two slides the next one is the one underneath, already loaded and opaque: mount it once.
  if (next && next.id !== previous?.id) layers.push({ slide: next, role: "next" });
  return { playable, index, current, previous, next, layers };
}

/**
 * Points the playlist at slides that can still be shown, and forgets what is no longer on
 * screen, so its sets never outgrow the three photos mounted at once. A move the timer was
 * waiting for is dropped when the current slide changes, and made at once when the photo now
 * next has already loaded (no load event will come for it). With fewer than two photos there is
 * nothing to pause, so a pause ends: the TV plays as soon as the next photos arrive.
 */
function settle(playlist: Playlist): Playlist {
  const view = viewPlaylist(playlist);
  const currentId = view.current?.id ?? null;
  const currentChanged = currentId !== playlist.currentId;
  const onScreen = new Set(view.layers.map((layer) => layer.slide.id));
  const settled: Playlist = {
    ...playlist,
    currentId,
    previousId: view.previous?.id ?? null,
    position: view.index,
    loaded: new Set([...playlist.loaded].filter((id) => onScreen.has(id))),
    // A slide that takes the place of one that failed or went away fades in, with its own time.
    entrance: currentChanged ? "fade" : playlist.entrance,
    due: currentChanged ? false : playlist.due,
    paused: view.playable.length < 2 ? false : playlist.paused,
  };
  if (settled.due && !settled.paused && view.next && settled.loaded.has(view.next.id)) return move(settled, 1, "fade");
  return settled;
}

function move(playlist: Playlist, step: 1 | -1, entrance: Entrance): Playlist {
  const view = viewPlaylist(playlist);
  if (!view.current || view.playable.length < 2) return playlist;
  const index = wrapIndex(view.index + step, view.playable.length);
  return settle({
    ...playlist,
    previousId: view.current.id,
    currentId: view.playable[index].id,
    position: index,
    entrance,
    due: false,
  });
}

export function playlistReducer(playlist: Playlist, action: PlaylistAction): Playlist {
  switch (action.type) {
    case "step":
      return move(playlist, action.step, action.step === 1 ? "forward" : "back");

    case "tick": {
      if (playlist.paused) return playlist;
      const { next } = viewPlaylist(playlist);
      if (!next) return playlist;
      if (playlist.loaded.has(next.id)) return move(playlist, 1, "fade");
      return playlist.due ? playlist : { ...playlist, due: true };
    }

    case "loaded": {
      const view = viewPlaylist(playlist);
      if (playlist.loaded.has(action.id) || !view.layers.some((layer) => layer.slide.id === action.id)) return playlist;
      const loaded = { ...playlist, loaded: new Set(playlist.loaded).add(action.id) };
      return loaded.due && !loaded.paused && view.next?.id === action.id ? move(loaded, 1, "fade") : loaded;
    }

    case "failed": {
      if (playlist.failed.has(action.id) || !playlist.slides.some((slide) => slide.id === action.id)) return playlist;
      return settle({ ...playlist, failed: new Set(playlist.failed).add(action.id) });
    }

    case "replaced":
      return settle({ ...playlist, slides: action.slides, failed: new Set() });

    case "toggle-pause":
      // Like the phone bar, which offers no pause with fewer than two photos.
      if (viewPlaylist(playlist).playable.length < 2) return playlist;
      return { ...playlist, paused: !playlist.paused, due: false };
  }
}

/**
 * Each photo's time on screen, kept across a pause (or a hidden tab) so play carries on where
 * it stopped instead of starting the photo's time again.
 */
export function createSlideClock(intervalMs: number, now: () => number = () => performance.now()) {
  let slideId: string | null = null;
  let elapsed = 0;
  let startedAt: number | null = null;
  return {
    /** Starts (or resumes) timing a slide; returns how long it has left. */
    start(id: string | null): number {
      if (id !== slideId) {
        slideId = id;
        elapsed = 0;
      }
      startedAt = now();
      return Math.max(0, intervalMs - elapsed);
    },
    /** Stops timing, keeping the time spent so far. */
    stop(): void {
      if (startedAt !== null) elapsed += now() - startedAt;
      startedAt = null;
    },
  };
}
