"use client";

import { useEffect, useRef, useState } from "react";
import { songs } from "@/content/songs";
import { Icon, PauseGlyph, PlayGlyph } from "@/components/ui/Icon";
import { useMusic } from "./MusicProvider";

function clock(t: number) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Four bars that dance while music plays. */
export function Bars({ playing }: { playing: boolean }) {
  const bars: [number, number][] = [
    [14, 0],
    [20, 150],
    [12, 300],
    [18, 450],
  ];
  return (
    <span className="flex items-end gap-[3px]" aria-hidden>
      {bars.map(([h, delay]) => (
        <span
          key={delay}
          className="block w-[3px] origin-bottom rounded-sm bg-ember"
          style={{
            height: h,
            animation: playing ? `bar 900ms ease-in-out ${delay}ms infinite` : undefined,
            transform: playing ? undefined : "scaleY(0.45)",
          }}
        />
      ))}
    </span>
  );
}

/** Opening settles gently; closing gets out of the way faster. */
const opening = "duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]";
const closing = "duration-200 ease-[cubic-bezier(0.4,0,1,1)]";

/**
 * The floating music pill with its playlist card.
 * The playlist button grows the card out of the pill's corner; the ✕ on either,
 * a tap anywhere else, or Escape puts it away. Phones get a slimmer pill.
 */
export function MusicPlayer({ autoplay = false }: { autoplay?: boolean }) {
  const music = useMusic();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const song = songs[music.track];

  useEffect(() => {
    if (autoplay) music.requestAutoplay();
    // Run once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      toggleButton.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    toggleButton.current?.focus();
  }

  const frac = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;

  return (
    <div ref={root} data-music-player className="relative">
      <div
        id="playlist-card"
        role="region"
        aria-label="Our playlist"
        className={`absolute right-0 bottom-[calc(100%+12px)] w-[min(340px,calc(100vw-32px))] origin-bottom-right rounded-[var(--radius-paper)] bg-white px-2.5 pt-1.5 pb-2 text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.08),0_18px_44px_rgb(61_41_39/0.18)] transition-[opacity,scale,translate,visibility] ${
          open ? `visible translate-y-0 scale-100 opacity-100 ${opening}` : `invisible translate-y-1.5 scale-95 opacity-0 ${closing}`
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-hairline pb-1 pl-2">
          <span className="font-script text-[26px] leading-tight">Songs for the two of us</span>
          <button
            type="button"
            onClick={close}
            aria-label="Close our playlist"
            className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-cocoa transition-colors hover:bg-tray"
          >
            <Icon name="close" size={18} strokeWidth={1.7} />
          </button>
        </div>

        <div className="flex flex-col border-b border-hairline px-2 pt-2.5 pb-2">
          <div className="relative h-6">
            <div aria-hidden className="absolute inset-x-0 top-2.5 h-1 rounded-sm bg-hairline" />
            <div
              aria-hidden
              className="pointer-events-none absolute top-2.5 left-0 h-1 rounded-sm bg-ember"
              style={{ width: `calc(8px + (100% - 16px) * ${frac.toFixed(4)})` }}
            />
            <input
              type="range"
              className="seek absolute inset-0 m-0 h-6 w-full"
              min={0}
              max={Math.round(music.duration)}
              step={1}
              value={Math.floor(music.position)}
              onChange={(e) => music.seek(Number(e.target.value))}
              aria-label={`Position in ${song.title}`}
              aria-valuetext={`${clock(music.position)} of ${clock(music.duration)}`}
            />
          </div>
          <div className="flex justify-between text-[11px] tracking-wide text-mocha">
            <span>{clock(music.position)}</span>
            <span>{clock(music.duration)}</span>
          </div>
          <div className="-mt-1 flex items-center justify-center gap-6">
            <button
              type="button"
              onClick={music.prev}
              aria-label="Previous song"
              className="press flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-tray"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path d="M6 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M19 5.5L9 12l10 6.5z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={music.toggle}
              aria-pressed={music.playing}
              aria-label={`${music.playing ? "Pause" : "Play"} ${song.title}`}
              className="press flex size-12 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]"
            >
              {music.playing ? <PauseGlyph size={18} /> : <PlayGlyph size={18} />}
            </button>
            <button
              type="button"
              onClick={music.next}
              aria-label="Next song"
              className="press flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-tray"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
                <path d="M18 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M5 5.5L15 12 5 18.5z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        <ol className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1.5">
          {songs.map((s, i) => {
            const current = i === music.track;
            const on = current && music.playing;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => (current ? music.toggle() : music.playTrack(i))}
                  aria-pressed={on}
                  aria-label={`${on ? "Pause" : "Play"} ${s.title}`}
                  className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[var(--radius-paper)] border-0 px-2 py-1.5 text-left transition-colors hover:bg-blush ${current ? "bg-blush" : "bg-transparent"}`}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-halo text-ember">
                    {on ? <Bars playing /> : <PlayGlyph size={11} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-serif text-[17px] leading-tight italic">{s.title}</span>
                    <span className="truncate text-[11px] tracking-wide text-mocha">{s.artist}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tracking-wide text-mocha">{clock(s.seconds)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex min-h-12 items-center gap-0.5 rounded-full bg-white p-0.5 pl-1 text-cocoa shadow-[var(--shadow-pill-white)] sm:min-h-14 sm:gap-1 sm:p-2">
        <button
          type="button"
          onClick={music.toggle}
          aria-pressed={music.playing}
          aria-label={music.playing ? "Pause our song" : "Play our song"}
          className="flex min-h-11 cursor-pointer items-center gap-2.5 border-0 bg-transparent pr-1.5 text-left sm:gap-3 sm:pr-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-halo sm:size-10">
            <Bars playing={music.playing} />
          </span>
          <span className="dock-label flex min-w-0 flex-col">
            <span className="text-[10px] uppercase tracking-[0.18em] text-mocha sm:text-[11px]">
              {music.playing ? "Now playing" : "Play our song"}
            </span>
            <span className="hidden max-w-[260px] truncate font-serif text-lg leading-tight italic sm:block">
              {song.title} · {song.artist}
            </span>
            <span className="max-w-[112px] truncate font-serif text-[14px] leading-tight italic sm:hidden">{song.title}</span>
          </span>
        </button>
        <button
          ref={toggleButton}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="playlist-card"
          aria-label={open ? "Hide our playlist" : "Show our playlist"}
          className="relative flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-tray text-cocoa transition-colors hover:bg-halo"
        >
          <Icon
            name="playlist"
            size={18}
            strokeWidth={1.7}
            className={`absolute transition-[opacity,rotate] ${open ? `rotate-90 opacity-0 ${opening}` : `rotate-0 opacity-100 ${closing}`}`}
          />
          <Icon
            name="close"
            size={18}
            strokeWidth={1.7}
            className={`absolute transition-[opacity,rotate] ${open ? `rotate-0 opacity-100 ${opening}` : `-rotate-90 opacity-0 ${closing}`}`}
          />
        </button>
      </div>
    </div>
  );
}
