"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Wish, WishRecording } from "@/lib/data/types";
import { Icon, PauseGlyph, PlayGlyph } from "@/components/ui/Icon";
import { wishMediaWatch } from "./wish-media-watch";

/*
 * What the wishes wall plays (Ruling BS): the files the worker made, never the guest's original,
 * each with preload="none", so the wall pulls no sound or video over mobile data before a tap. And
 * the sender's own card while their recording is made ready (Ruling BR).
 */

const cardShadow = "shadow-[0_1px_2px_rgb(61_41_39/0.06),0_12px_28px_rgb(61_41_39/0.08)]";

/** A fixed two-tone waveform: the played part in ember, the rest in mist. */
const BARS = [6, 14, 8, 18, 10, 4, 16, 10, 6, 20, 12, 6, 14, 8, 16, 4, 12, 8, 18, 10, 6, 14, 8, 12, 4];

function Waveform({ played }: { played: number }) {
  return (
    <svg width="100%" height="22" viewBox="0 0 200 22" preserveAspectRatio="none" aria-hidden>
      {BARS.map((height, position) => (
        <rect
          key={position}
          x={position * 8}
          y={(22 - height) / 2}
          width="3"
          height={height}
          rx="1.5"
          fill={position / BARS.length < played ? "var(--color-ember)" : "var(--color-mist)"}
        />
      ))}
    </svg>
  );
}

/** A voice note on the wall: an ember play button, the waveform filling as it plays, and its length. */
export function VoicePlayer({ wish, recording, index }: { wish: Wish; recording: WishRecording; index: number }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(0);

  function toggle() {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  }

  return (
    <article
      className={`paper-card flex items-center gap-3.5 rounded-full bg-white py-2.5 pr-5.5 pl-2.5 ${cardShadow}`}
      style={{ transform: `rotate(${index % 2 ? -0.5 : 0.5}deg)` }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={`${playing ? "Pause" : "Play"} voice note from ${wish.signedAs}`}
        className="press flex size-12 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]"
      >
        {playing ? <PauseGlyph size={16} /> : <PlayGlyph size={16} className="ml-0.5" />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Waveform played={played} />
        <p className="m-0 truncate text-xs text-mocha">
          {wish.signedAs} · voice note{wish.duration ? ` · ${wish.duration}` : ""}
        </p>
      </div>
      <audio
        ref={audio}
        src={recording.url}
        preload="none"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          const element = event.currentTarget;
          setPlayed(Number.isFinite(element.duration) && element.duration > 0 ? element.currentTime / element.duration : 0);
        }}
        onEnded={() => {
          setPlaying(false);
          setPlayed(0);
        }}
      />
    </article>
  );
}

/** A video message's frame: its own shape, from a 4:5 portrait to a 16:9 landscape. */
function aspectOf(recording: WishRecording): string {
  const ratio = recording.width && recording.height ? recording.width / recording.height : 4 / 5;
  return String(Math.min(16 / 9, Math.max(4 / 5, ratio)));
}

/** The poster thumbnail's own size: the picture's shape fitted within 480 px, as the worker made it. */
export function thumbSizeOf(recording: Pick<WishRecording, "width" | "height">): { width: number; height: number } {
  const width = recording.width ?? 400;
  const height = recording.height ?? 500;
  const scale = Math.min(1, 480 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * A video message on the wall (fix round 1): until a tap, only its poster's thumbnail, the 480 px
 * one (about 30 KB), lazily loaded with its size given, on its average colour; no video element
 * at all, so nothing of the video, and no poster-sized picture, is fetched before a tap, above or
 * below the fold. Tapped, the video element is made and plays at once, with the phone's controls.
 */
export function VideoPlayer({ wish, recording, index }: { wish: Wish; recording: WishRecording; index: number }) {
  const video = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const thumb = thumbSizeOf(recording);

  function play() {
    // The element is made now, inside the tap, so play() is the tap's own (phones allow sound then).
    flushSync(() => setStarted(true));
    void video.current?.play().catch(() => {});
  }

  return (
    <article
      className={`paper-card flex flex-col rounded-[var(--radius-paper)] bg-white px-2 pt-2 ${cardShadow}`}
      style={{ transform: `rotate(${index % 2 ? 0.4 : -0.4}deg)` }}
    >
      <div
        className="relative overflow-hidden bg-cocoa"
        style={{ aspectRatio: aspectOf(recording), backgroundColor: started ? undefined : (recording.color ?? undefined) }}
      >
        {started ? (
          <video
            ref={video}
            src={recording.url}
            playsInline
            controls
            aria-label={`Video message from ${wish.signedAs}`}
            className="absolute inset-0 size-full object-contain"
          />
        ) : (
          <>
            {recording.thumb ? (
              // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
              <img
                src={recording.thumb}
                alt=""
                width={thumb.width}
                height={thumb.height}
                loading="lazy"
                decoding="async"
                className="absolute inset-0 size-full object-cover"
              />
            ) : null}
            <button
              type="button"
              onClick={play}
              aria-label={`Play video message from ${wish.signedAs}`}
              className="absolute inset-0 flex cursor-pointer items-center justify-center"
            >
              <span className="press flex size-14 items-center justify-center rounded-full bg-white/95 text-cocoa shadow-[0_4px_14px_rgb(61_41_39/0.2)]">
                <PlayGlyph size={18} className="ml-0.5" />
              </span>
            </button>
          </>
        )}
      </div>
      <footer className="flex items-baseline justify-between gap-3 px-2.5 pt-3 pb-3.5">
        <span className="min-w-0 font-script text-[22px] break-words text-mocha">{wish.signedAs}</span>
        <span className="shrink-0 text-xs text-mocha">video{wish.duration ? ` · ${wish.duration}` : ""}</span>
      </footer>
    </article>
  );
}

/**
 * The sender's own recorded wish while it is made ready, or once that failed (Ruling BR): nobody
 * else's wall shows it. It asks after its recording with the page's other pending cards (one
 * batched read a round, wish-media-watch.ts): ready, the wall is read again, and the card becomes
 * the wish's player; failed, it says so; gone (hidden or deleted meanwhile), it leaves the wall.
 */
export function PendingWish({ wish, index }: { wish: Wish; index: number }) {
  const router = useRouter();
  const mediaId = wish.pending?.mediaId ?? null;
  const [state, setState] = useState(wish.pending?.state ?? "processing");
  const [gone, setGone] = useState(false);
  // The wall is read again once for this card: should the server still say "getting ready" (a
  // ready recording whose file isn't there), the card waits as it is rather than refresh forever.
  const refreshed = useRef(false);

  useEffect(() => {
    if (!mediaId || state !== "processing") return;
    let stop: (() => void) | null = null;
    stop = wishMediaWatch().watch(mediaId, (item) => {
      if (!item) {
        setGone(true);
        stop?.();
      } else if (item.state === "failed") {
        setState("failed");
        stop?.();
      } else if (item.state === "ready") {
        stop?.();
        if (refreshed.current) return;
        refreshed.current = true;
        startTransition(() => router.refresh());
      }
    });
    return () => stop?.();
  }, [mediaId, state, router]);

  if (gone) return null;
  const what = wish.kind === "video" ? "video" : "voice note";
  const failed = state === "failed";
  return (
    <article
      data-pending-wish={failed ? "failed" : "processing"}
      className={`flex items-center gap-3.5 rounded-full bg-white py-2.5 pr-5.5 pl-2.5 ${cardShadow}`}
      style={{ transform: `rotate(${index % 2 ? -0.5 : 0.5}deg)` }}
    >
      <span className={`grid size-12 shrink-0 place-items-center rounded-full ${failed ? "bg-alert-tint text-alert" : "bg-tray"}`} aria-hidden>
        {failed ? <Icon name="alert" size={18} strokeWidth={2.2} /> : <span className="upload-spinner size-4" />}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        {failed ? (
          <>
            <p className="m-0 font-serif text-lg leading-[1.25] italic">We couldn&apos;t read this recording.</p>
            <p className="m-0 text-xs text-mocha">Try recording it again.</p>
          </>
        ) : (
          <>
            <p className="m-0 font-serif text-lg leading-[1.25] italic" role="status">
              Getting your wish ready…
            </p>
            <p className="m-0 truncate text-xs text-mocha">
              {wish.signedAs} · {what}
            </p>
          </>
        )}
      </div>
    </article>
  );
}
