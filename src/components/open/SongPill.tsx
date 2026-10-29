"use client";

import { songs } from "@/content/songs";
import { Bars } from "@/components/music/MusicPlayer";
import { useMusic } from "@/components/music/MusicProvider";

/** White pill at the foot of the envelope page: play or pause our song. */
export function SongPill({ className = "" }: { className?: string }) {
  const { playing, buffering, toggle, track } = useMusic();
  const loading = playing && buffering;
  const song = songs[track];
  return (
    <button
      type="button"
      data-music-player
      onClick={toggle}
      aria-pressed={playing}
      aria-label={`${playing ? "Pause" : "Play"} our song, ${song.title}`}
      className={`press flex min-h-13.5 cursor-pointer items-center gap-3 rounded-full border-0 bg-white py-1.75 pr-5 pl-1.75 text-left text-cocoa shadow-[0_1px_2px_rgb(0_0_0/0.2),0_10px_26px_rgb(0_0_0/0.28)] ${className}`}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-halo">
        <Bars playing={playing} loading={loading} />
      </span>
      <span className="flex flex-col gap-px">
        <span className="text-[11px] uppercase tracking-[0.18em] text-mocha">
          {loading ? "Loading…" : playing ? "Now playing" : "Play our song"}
        </span>
        <span className="font-serif text-[17px] leading-[1.1] italic">{song.title}</span>
      </span>
    </button>
  );
}
