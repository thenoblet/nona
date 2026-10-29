"use client";

import { useEffect, useState } from "react";
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

/**
 * The floating music pill with its playlist card.
 * Phones: a compact pill; the list button opens the card as a sheet above it.
 * Desktop: hovering the pill also opens the card.
 */
export function MusicPlayer({ autoplay = false }: { autoplay?: boolean }) {
  const music = useMusic();
  const [open, setOpen] = useState(false);
  const song = songs[music.track];

  useEffect(() => {
    if (autoplay) music.requestAutoplay();
    // Run once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay]);

  const frac = music.duration > 0 ? Math.min(1, music.position / music.duration) : 0;

  return (
    <div data-music-player className="group relative">
      <div
        role="region"
        aria-label="Our playlist"
        className={`absolute right-0 bottom-[calc(100%+14px)] w-[min(360px,calc(100vw-32px))] rounded-[var(--radius-paper)] bg-white px-3.5 pt-5 pb-3 text-cocoa shadow-[0_1px_2px_rgb(61_41_39/0.08),0_18px_44px_rgb(61_41_39/0.18)] transition-[opacity,translate,visibility] duration-300 after:absolute after:inset-x-0 after:top-full after:h-4 after:content-[''] group-focus-within:visible group-focus-within:translate-y-0 group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:visible [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-hover:opacity-100 ${
          open ? "visible translate-y-0 opacity-100" : "invisible translate-y-2.5 opacity-0"
        }`}
      >
        <div className="mb-1.5 flex flex-col gap-0.5 border-b border-hairline px-2.5 pb-3.5">
          <span className="text-[11px] uppercase tracking-[0.24em] text-mocha">Our playlist</span>
          <span className="font-script text-[32px] leading-tight">Songs for the two of us</span>
        </div>

        <div className="mb-1.5 flex flex-col gap-2 border-b border-hairline px-2.5 pt-0.5 pb-3.5">
          <div className="flex flex-col gap-0.5">
            <span className="font-serif text-[22px] leading-tight italic">{song.title}</span>
            <span className="text-xs tracking-wide text-mocha">{song.artist}</span>
          </div>
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
              aria-label="Position in the song"
              aria-valuetext={`${clock(music.position)} of ${clock(music.duration)}`}
            />
          </div>
          <div className="flex justify-between text-xs tracking-wide text-mocha">
            <span>{clock(music.position)}</span>
            <span>{clock(music.duration)}</span>
          </div>
          <div className="mt-0.5 flex items-center justify-center gap-5">
            <button
              type="button"
              onClick={music.prev}
              aria-label="Previous song"
              className="press flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-tray"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path d="M6 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M19 5.5L9 12l10 6.5z" fill="currentColor" />
              </svg>
            </button>
            <button
              type="button"
              onClick={music.toggle}
              aria-pressed={music.playing}
              aria-label={music.playing ? "Pause" : "Play"}
              className="press flex size-14 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]"
            >
              {music.playing ? <PauseGlyph size={20} /> : <PlayGlyph size={20} />}
            </button>
            <button
              type="button"
              onClick={music.next}
              aria-label="Next song"
              className="press flex size-11 cursor-pointer items-center justify-center rounded-full hover:bg-tray"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
                <path d="M18 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M5 5.5L15 12 5 18.5z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        <ol className="m-0 flex list-none flex-col gap-1 p-0">
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
                  className={`flex min-h-14 w-full cursor-pointer items-center gap-3.5 rounded-[var(--radius-paper)] border-0 px-2.5 py-2 text-left transition-colors hover:bg-blush ${current ? "bg-blush" : "bg-transparent"}`}
                >
                  <span className="flex size-9.5 shrink-0 items-center justify-center rounded-full bg-halo text-ember">
                    {on ? <Bars playing /> : <PlayGlyph size={13} />}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-serif text-xl leading-tight italic">{s.title}</span>
                    <span className="text-xs tracking-wide text-mocha">{s.artist}</span>
                  </span>
                  <span className="shrink-0 text-xs tracking-wide text-mocha">{clock(s.seconds)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex min-h-14 items-center gap-1 rounded-full bg-white p-1.5 text-cocoa shadow-[var(--shadow-pill-white)] sm:p-2">
        <button
          type="button"
          onClick={music.toggle}
          aria-pressed={music.playing}
          aria-label={music.playing ? "Pause our song" : "Play our song"}
          className="flex min-h-11 cursor-pointer items-center gap-3 border-0 bg-transparent pr-2 text-left sm:pr-3"
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-halo">
            <Bars playing={music.playing} />
          </span>
          <span className="dock-label flex min-w-0 flex-col">
            <span className="text-[11px] uppercase tracking-[0.18em] text-mocha">
              {music.playing ? "Now playing" : "Play our song"}
            </span>
            <span className="hidden max-w-[260px] truncate font-serif text-lg leading-tight italic sm:block">
              {song.title} · {song.artist}
            </span>
            <span className="max-w-[120px] truncate font-serif text-[15px] leading-tight italic sm:hidden">{song.title}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={open ? "Hide our playlist" : "Show our playlist"}
          className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-tray text-cocoa transition-colors hover:bg-halo"
        >
          <Icon name={open ? "close" : "playlist"} size={18} strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}
