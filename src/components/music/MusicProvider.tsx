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
import { songs } from "@/content/songs";

type MusicState = {
  track: number;
  playing: boolean;
  position: number;
  duration: number;
};

type MusicApi = MusicState & {
  toggle: () => void;
  play: () => void;
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

/**
 * Lives in the root layout so the songs keep playing across page changes.
 * The songs play one after another and loop back to the first.
 */
export function MusicProvider({ children }: { children: ReactNode }) {
  const audios = useRef<(HTMLAudioElement | null)[]>([]);
  const userPaused = useRef(false);
  const unlockRef = useRef<((e: Event) => void) | null>(null);
  const [state, setState] = useState<MusicState>({
    track: 0,
    playing: false,
    position: 0,
    duration: songs[0].seconds,
  });
  // The current track, readable from event handlers without waiting for a re-render.
  const trackRef = useRef(0);

  const startEl = useCallback((el: HTMLAudioElement | null | undefined) => {
    if (!el) return;
    const p = el.play();
    if (p) p.catch(() => {});
  }, []);

  const playTrack = useCallback(
    (index: number) => {
      const n = songs.length;
      const i = ((index % n) + n) % n;
      audios.current.forEach((a, k) => {
        if (a && k !== i && !a.paused) a.pause();
      });
      const el = audios.current[i];
      if (!el) return;
      try {
        el.currentTime = 0;
      } catch {}
      userPaused.current = false;
      trackRef.current = i;
      setState((s) => ({ ...s, track: i, position: 0, duration: songs[i].seconds }));
      startEl(el);
    },
    [startEl],
  );

  const play = useCallback(() => {
    userPaused.current = false;
    startEl(audios.current[trackRef.current]);
  }, [startEl]);

  const toggle = useCallback(() => {
    const el = audios.current[trackRef.current];
    if (!el) return;
    if (el.paused) {
      userPaused.current = false;
      startEl(el);
    } else {
      userPaused.current = true;
      el.pause();
    }
  }, [startEl]);

  const next = useCallback(() => playTrack(trackRef.current + 1), [playTrack]);

  const prev = useCallback(() => {
    const el = audios.current[trackRef.current];
    // Like most players: restart the song, unless we're right at its start.
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      if (el.paused) {
        userPaused.current = false;
        startEl(el);
      }
      return;
    }
    playTrack(trackRef.current - 1);
  }, [playTrack, startEl]);

  const seek = useCallback((seconds: number) => {
    const el = audios.current[trackRef.current];
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
    const el = audios.current[trackRef.current];
    if (!el || !el.paused || userPaused.current) return;
    const p = el.play();
    if (!p) return;
    p.catch(() => {
      // Browsers only allow sound after a tap. Start on the first one,
      // unless the tap is on the player itself (it handles that tap).
      removeUnlock();
      const unlock = (e: Event) => {
        removeUnlock();
        const target = e.target as Element | null;
        if (target?.closest?.("[data-music-player]")) return;
        const cur = audios.current[trackRef.current];
        if (cur && cur.paused && !userPaused.current) startEl(cur);
      };
      unlockRef.current = unlock;
      document.addEventListener("pointerdown", unlock);
      document.addEventListener("keydown", unlock);
    });
  }, [removeUnlock, startEl]);

  useEffect(() => removeUnlock, [removeUnlock]);

  const api = useMemo<MusicApi>(
    () => ({ ...state, toggle, play, playTrack, next, prev, seek, requestAutoplay }),
    [state, toggle, play, playTrack, next, prev, seek, requestAutoplay],
  );

  return (
    <MusicContext.Provider value={api}>
      {children}
      {songs.map((song, i) => (
        <audio
          key={song.id}
          ref={(el) => {
            audios.current[i] = el;
          }}
          preload={i === 0 ? "metadata" : "none"}
          onPlay={() => {
            audios.current.forEach((a, k) => {
              if (a && k !== i && !a.paused) a.pause();
            });
            trackRef.current = i;
            setState((s) => ({ ...s, track: i, playing: true }));
          }}
          onPause={() => {
            if (trackRef.current === i) setState((s) => ({ ...s, playing: false }));
          }}
          onTimeUpdate={(e) => {
            if (trackRef.current !== i) return;
            const t = e.currentTarget.currentTime;
            setState((s) => (Math.floor(s.position) === Math.floor(t) ? s : { ...s, position: t }));
          }}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (trackRef.current === i && Number.isFinite(d) && d > 0) setState((s) => ({ ...s, duration: d }));
          }}
          onEnded={() => playTrack(i + 1)}
        >
          {song.sources.map((s) => (
            <source key={s.src} src={s.src} type={s.type} />
          ))}
        </audio>
      ))}
    </MusicContext.Provider>
  );
}
