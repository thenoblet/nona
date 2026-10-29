"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { songs, type Song } from "@/content/songs";

type MusicState = {
  track: number;
  /** The guest wants music playing (pause shows, the pill says Now playing). */
  playing: boolean;
  /** Playing was asked for, but the song is still loading: nothing is audible yet. */
  buffering: boolean;
  position: number;
  duration: number;
};

type MusicApi = MusicState & {
  toggle: () => void;
  play: () => void;
  pause: () => void;
  playTrack: (index: number) => void;
  next: () => void;
  prev: () => void;
  seek: (seconds: number) => void;
  /** Try to start the music; if the browser blocks it, start on the first tap. */
  requestAutoplay: () => void;
};

const MusicContext = createContext<MusicApi | null>(null);

export function useMusic() {
  const ctx = useContext(MusicContext);
  if (!ctx) throw new Error("useMusic must be used inside <MusicProvider>");
  return ctx;
}

/** The first source this browser says it can play, as a <source> list would choose. */
function sourceFor(el: HTMLAudioElement, song: Song, skip = 0) {
  const playable = song.sources.filter((s) => el.canPlayType(s.type) !== "");
  return (playable[skip] ?? song.sources[song.sources.length - 1]).src;
}

const wrap = (i: number) => ((i % songs.length) + songs.length) % songs.length;

/**
 * Lives in the root layout so the songs keep playing across page changes.
 * The songs play one after another and loop back to the first.
 *
 * One <audio> element plays every song. iPhones unlock sound per element, so a
 * fresh element for the next song would stay silent when the previous one ends.
 */
export function MusicProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<MusicState>({
    track: 0,
    playing: false,
    buffering: false,
    position: 0,
    duration: songs[0].seconds,
  });
  // Read from event handlers without waiting for a re-render.
  const trackRef = useRef(0);
  // How many of this song's sources have failed to load, to fall back to the next.
  const failedSources = useRef(0);
  // Pause events fired by switching songs are not the guest pausing.
  const switching = useRef(false);
  // Autoplay only ever starts the music once; after that, only the guest does.
  const started = useRef(false);
  const unlockRef = useRef<((e: Event) => void) | null>(null);

  const start = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    const p = el.play();
    if (p)
      p.catch(() => {
        // Blocked or interrupted (a quick skip to another song). Show what is true.
        switching.current = false;
        if (el.paused) setState((s) => ({ ...s, playing: false, buffering: false }));
      });
  }, []);

  const load = useCallback((i: number) => {
    const el = audio.current;
    if (!el) return;
    switching.current = !el.paused;
    trackRef.current = i;
    failedSources.current = 0;
    el.src = sourceFor(el, songs[i]);
    setState((s) => ({ ...s, track: i, position: 0, duration: songs[i].seconds }));
  }, []);

  const playTrack = useCallback(
    (index: number) => {
      load(wrap(index));
      start();
    },
    [load, start],
  );

  const play = useCallback(() => start(), [start]);

  const pause = useCallback(() => audio.current?.pause(), []);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el) return;
    if (el.paused) start();
    else el.pause();
  }, [start]);

  const next = useCallback(() => playTrack(trackRef.current + 1), [playTrack]);

  const prev = useCallback(() => {
    const el = audio.current;
    // Like most players: restart the song, unless we're right at its start.
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      if (el.paused) start();
      return;
    }
    playTrack(trackRef.current - 1);
  }, [playTrack, start]);

  const seek = useCallback((seconds: number) => {
    const el = audio.current;
    if (!el) return;
    try {
      el.currentTime = seconds;
    } catch {}
    setState((s) => ({ ...s, position: seconds }));
  }, []);

  const removeUnlock = useCallback(() => {
    if (!unlockRef.current) return;
    document.removeEventListener("pointerdown", unlockRef.current);
    document.removeEventListener("keydown", unlockRef.current);
    unlockRef.current = null;
  }, []);

  const requestAutoplay = useCallback(() => {
    const el = audio.current;
    if (!el || started.current || !el.paused) return;
    const p = el.play();
    if (!p) return;
    p.catch(() => {
      // Browsers only allow sound after a tap: start on the first one. A tap on the
      // player itself is left to the player (it may be opening the playlist), and
      // the listener stays armed until the music has started.
      removeUnlock();
      const unlock = (e: Event) => {
        if ((e.target as Element | null)?.closest?.("[data-music-player]")) return;
        removeUnlock();
        if (!started.current && audio.current?.paused) start();
      };
      unlockRef.current = unlock;
      document.addEventListener("pointerdown", unlock);
      document.addEventListener("keydown", unlock);
    });
  }, [removeUnlock, start]);

  // The first song is ready to go (and its length known) before anyone taps play.
  useEffect(() => {
    const el = audio.current;
    if (el && !el.getAttribute("src")) el.src = sourceFor(el, songs[0]);
    return removeUnlock;
  }, [removeUnlock]);

  // Lock screen, headphones and car controls.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", play],
      ["pause", pause],
      ["nexttrack", next],
      ["previoustrack", prev],
      ["seekto", (d) => d.seekTime != null && seek(d.seekTime)],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {}
    }
    return () => {
      for (const [action] of handlers) {
        try {
          ms.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [play, pause, next, prev, seek]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const song = songs[state.track];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title,
      artist: song.artist,
      album: "Noblet & Nancy",
      artwork: [{ src: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    });
  }, [state.track]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
  }, [state.playing]);

  const api = useMemo<MusicApi>(
    () => ({ ...state, toggle, play, pause, playTrack, next, prev, seek, requestAutoplay }),
    [state, toggle, play, pause, playTrack, next, prev, seek, requestAutoplay],
  );

  return (
    <MusicContext.Provider value={api}>
      {children}
      <audio
        ref={audio}
        preload="metadata"
        onPlay={() => {
          switching.current = false;
          setState((s) => ({ ...s, playing: true }));
        }}
        onPlaying={() => {
          started.current = true;
          removeUnlock();
          setState((s) => ({ ...s, playing: true, buffering: false }));
        }}
        onWaiting={() => setState((s) => (s.playing ? { ...s, buffering: true } : s))}
        onPause={() => {
          // Switching songs pauses for a moment; keep showing the music as playing.
          if (switching.current) return;
          setState((s) => ({ ...s, playing: false, buffering: false }));
        }}
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setState((s) => (Math.floor(s.position) === Math.floor(t) ? s : { ...s, position: t }));
          const d = e.currentTarget.duration;
          if ("mediaSession" in navigator && Number.isFinite(d) && d > 0 && t <= d) {
            try {
              navigator.mediaSession.setPositionState({ duration: d, position: t, playbackRate: 1 });
            } catch {}
          }
        }}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d) && d > 0) setState((s) => ({ ...s, duration: d }));
        }}
        onError={(e) => {
          // This browser listed the format but couldn't play the file: try the next one.
          const el = e.currentTarget;
          const song = songs[trackRef.current];
          if (failedSources.current + 1 >= song.sources.length) return;
          failedSources.current += 1;
          const resume = state.playing;
          el.src = sourceFor(el, song, failedSources.current);
          if (resume) start();
        }}
        onEnded={() => playTrack(trackRef.current + 1)}
      />
    </MusicContext.Provider>
  );
}
