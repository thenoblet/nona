"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { couple, wedding } from "@/content/wedding";
import { PillLink } from "@/components/ui/Button";
import { Icon, PauseGlyph, PlayGlyph } from "@/components/ui/Icon";
import { QrCode } from "@/components/ui/QrCode";
import { fetchSlides, pollSlides } from "./feed";
import { createSlideClock, playlistReducer, startPlaylist, viewPlaylist, type Slide } from "./playlist";
import { useDocumentHidden, useFullscreen, useIdle, useWakeLock } from "./screen";
import { SlideImage } from "./SlideImage";
import { SlideshowStage } from "./SlideshowStage";

/** How long each photo stays. */
const INTERVAL_MS = 6000;
/** How long to wait on a next photo that is still loading before skipping it. */
const STALL_MS = 15_000;
/** The pointer and the TV controls hide after this long without a move. */
const IDLE_MS = 3000;
/** A swipe is a mostly sideways move of at least this far. */
const SWIPE_PX = 40;
/** A tap moves less than this. */
const TAP_PX = 10;

/*
 * The TV layout: a 16:9 composition drawn at 1280 x 720 design pixels. Inside the frame one
 * spacing step is one design pixel scaled to the screen, so `p-40` is 40 design pixels and the
 * whole layout fills any 16:9 display. Small print never drops below 11 px, so a phone on its
 * side can still read it.
 */
const tvFrame = "tv:flex tv:h-720 tv:w-1280 tv:gap-40 tv:p-40 tv:[--spacing:min(0.078125vw,0.138889dvh)]";

/**
 * The slideshow on every screen. Portrait phones see the photo full screen under a slim bar;
 * landscape screens see the TV layout. Both run from one playlist: it moves on every six
 * seconds once the next photo has loaded, skips photos that fail, and asks for the latest list
 * every 30 s, keeping what it has when that fails. `slides` is null while the page loads.
 */
export function Slideshow({ slides, qrSvg }: { slides: Slide[] | null; qrSvg: string | null }) {
  const [playlist, dispatch] = useReducer(playlistReducer, slides ?? [], startPlaylist);
  const view = viewPlaylist(playlist);
  const { current, next } = view;
  const count = view.playable.length;
  const live = slides !== null;

  const hidden = useDocumentHidden();
  const fullscreen = useFullscreen();
  const { idle, wake } = useIdle(IDLE_MS);
  useWakeLock();

  const step = useCallback((direction: 1 | -1) => dispatch({ type: "step", step: direction }), []);
  const togglePause = useCallback(() => dispatch({ type: "toggle-pause" }), []);
  const onLoaded = useCallback((id: string) => dispatch({ type: "loaded", id }), []);
  const onFailed = useCallback((id: string) => dispatch({ type: "failed", id }), []);

  // Each photo's six seconds. A pause or a hidden tab keeps the time already spent.
  const [clock] = useState(() => createSlideClock(INTERVAL_MS));
  const currentId = current?.id ?? null;
  const running = !playlist.paused && !hidden && count > 1;
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => dispatch({ type: "tick" }), clock.start(currentId));
    return () => {
      clearTimeout(timer);
      clock.stop();
    };
  }, [clock, currentId, running]);

  // A next photo that never arrives (no error, no load) is skipped, so the screen never stalls.
  const stalledId = playlist.due && running ? (next?.id ?? null) : null;
  useEffect(() => {
    if (!stalledId) return;
    const timer = setTimeout(() => dispatch({ type: "failed", id: stalledId }), STALL_MS);
    return () => clearTimeout(timer);
  }, [stalledId]);

  useEffect(() => {
    if (!live) return;
    return pollSlides({
      load: () => fetchSlides(),
      onSlides: (fresh) => dispatch({ type: "replaced", slides: fresh }),
      isHidden: () => document.hidden,
    });
  }, [live]);

  // Arrows move, space pauses, F toggles full screen (the venue laptop's keyboard). Space always
  // pauses or plays, whatever has focus: a focused button never takes it (Enter still does).
  const toggleFullscreen = fullscreen.toggle;
  useEffect(() => {
    const ignored = (event: KeyboardEvent) =>
      event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented || event.isComposing || isEditable(event.target);
    const onKeyDown = (event: KeyboardEvent) => {
      if (ignored(event)) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        step(event.key === "ArrowRight" ? 1 : -1);
      } else if (event.key === " ") {
        event.preventDefault();
        if (!event.repeat) togglePause();
      } else if ((event.key === "f" || event.key === "F") && !event.repeat) {
        toggleFullscreen();
      } else {
        return;
      }
      wake();
    };
    // A focused button acts on space when the key comes up; that is the pause, not the button.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " && !ignored(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [step, togglePause, toggleFullscreen, wake]);

  // Swipes, and taps on the outer thirds, read from the pointer itself: after a quick swipe
  // Chrome takes the next tap as stopping the swipe and sends no click for it. The thirds are
  // buttons too, for the keyboard and screen readers, so the click a handled tap may still
  // send (or one that ends a swipe over a link) is dropped.
  const gesture = useRef<{ pointerX: number; pointerY: number } | null>(null);
  const handledUntil = useRef(0);
  const onPointerDown = (event: PointerEvent) => {
    handledUntil.current = 0;
    // A second finger (a pinch) cancels the gesture, as does any mouse button but the main one.
    gesture.current = event.isPrimary && event.button === 0 ? { pointerX: event.clientX, pointerY: event.clientY } : null;
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const start = gesture.current;
    gesture.current = null;
    if (!start) return;
    const across = event.clientX - start.pointerX;
    const down = event.clientY - start.pointerY;
    // While the guest has pinched in, a sideways move is looking around the photo, not a swipe.
    const zoomedIn = (window.visualViewport?.scale ?? 1) > 1.01;
    let direction: 1 | -1 | null = null;
    if (!zoomedIn && Math.abs(across) >= SWIPE_PX && Math.abs(across) > Math.abs(down) * 1.5) {
      direction = across < 0 ? 1 : -1;
    } else if (Math.abs(across) < TAP_PX && Math.abs(down) < TAP_PX && event.target instanceof Element) {
      const third = event.target.closest("[data-third]")?.getAttribute("data-third");
      direction = third === "next" ? 1 : third === "previous" ? -1 : null;
    }
    if (direction === null) return;
    step(direction);
    handledUntil.current = event.timeStamp + 800;
  };
  const onClickCapture = (event: MouseEvent) => {
    if (event.timeStamp > handledUntil.current) return;
    handledUntil.current = 0;
    event.preventDefault();
    event.stopPropagation();
  };

  const showControls = !idle || playlist.paused;
  const emptyMessage = !live
    ? "Loading the latest moments"
    : playlist.slides.length === 0
      ? "The first moments will appear here"
      : "The latest moments are on their way";

  return (
    <div
      className={`relative h-full w-full tv:grid tv:place-items-center ${idle ? "cursor-none **:cursor-none" : ""}`}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <div className={`relative h-full w-full ${tvFrame}`}>
        <section
          aria-label="Latest shared moments"
          aria-roledescription="carousel"
          className="relative h-full overflow-hidden bg-cocoa [touch-action:pinch-zoom] tv:min-w-0 tv:flex-1 tv:bg-mocha"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            gesture.current = null;
          }}
          onClickCapture={onClickCapture}
        >
          <SlideshowStage layers={view.layers} entrance={playlist.entrance} onLoaded={onLoaded} onFailed={onFailed} />

          {current ? (
            <>
              {count > 1 ? (
                <>
                  <button
                    type="button"
                    aria-label="Previous photo"
                    data-third="previous"
                    onMouseDown={keepFocusAway}
                    onClick={() => step(-1)}
                    className="absolute inset-y-0 left-0 z-10 w-1/3 cursor-pointer focus-visible:-outline-offset-4"
                  />
                  <button
                    type="button"
                    aria-label="Next photo"
                    data-third="next"
                    onMouseDown={keepFocusAway}
                    onClick={() => step(1)}
                    className="absolute inset-y-0 right-0 z-10 w-1/3 cursor-pointer focus-visible:-outline-offset-4"
                  />
                </>
              ) : null}
              <PhoneCaption slide={current} index={view.index} count={count} paused={playlist.paused} running={running} />
              <TvCaption slide={current} paused={playlist.paused} />
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-7 px-8 text-center tv:px-40">
              <p
                key={emptyMessage}
                className="m-0 animate-caption-in text-[11px] tracking-[0.24em] text-linen uppercase tv:text-[max(11px,calc(var(--spacing)*16))]"
              >
                {emptyMessage}
              </p>
              {live ? <AddYours className="tv:hidden" /> : null}
            </div>
          )}

          <PhoneBar paused={playlist.paused} canPause={count > 1} onTogglePause={togglePause} />

          <div
            role="group"
            aria-label="Slideshow controls"
            className={`absolute top-0 right-0 z-30 hidden gap-[max(6px,calc(var(--spacing)*8))] p-[max(8px,calc(var(--spacing)*16))] transition-opacity tv:flex ${
              showControls
                ? "opacity-100 duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                : "pointer-events-none opacity-0 duration-250 ease-[cubic-bezier(0.4,0,1,1)]"
            } has-focus-visible:pointer-events-auto has-focus-visible:opacity-100`}
          >
            {count > 1 ? (
              <>
                <TvButton label="Previous photo" onClick={() => step(-1)}>
                  <Icon name="back" className="size-[48%]" />
                </TvButton>
                <TvButton label={playlist.paused ? "Play the slideshow" : "Pause the slideshow"} onClick={togglePause}>
                  <PlayPause paused={playlist.paused} className="size-[42%]" />
                </TvButton>
                <TvButton label="Next photo" onClick={() => step(1)}>
                  <Icon name="forward" className="size-[48%]" />
                </TvButton>
              </>
            ) : null}
            {fullscreen.supported ? (
              <TvButton label={fullscreen.active ? "Leave full screen" : "Full screen"} onClick={toggleFullscreen}>
                <Icon name={fullscreen.active ? "collapse" : "expand"} className="size-[46%]" />
              </TvButton>
            ) : null}
          </div>
        </section>

        <aside className="hidden w-300 shrink-0 flex-col items-center justify-between py-12 text-center tv:flex">
          <div className="flex flex-col items-center gap-8">
            <p className="m-0 font-script text-[calc(var(--spacing)*72)] leading-none text-ember">{couple.monogram}</p>
            <p className="m-0 text-[max(11px,calc(var(--spacing)*13))] tracking-[0.3em] text-mist uppercase">{wedding.dateShort}</p>
          </div>

          <div className="flex flex-col items-center gap-14">
            <div className="bg-white p-12">
              {qrSvg ? <QrCode svg={qrSvg} className="size-168" /> : <div className="size-168 bg-white" />}
            </div>
            {/* The QR is for guests at the venue; a phone on its side can tap instead. */}
            <Link
              href="/album"
              className="inline-flex min-h-[44px] items-center font-serif text-[max(15px,calc(var(--spacing)*28))] leading-tight text-white no-underline"
            >
              <span className="ember-link">Add yours</span>
            </Link>
            <p className="m-0 text-[max(11px,calc(var(--spacing)*14))] leading-normal text-mist">
              Scan to share your photos. They&apos;ll appear here.
            </p>
          </div>

          <ThumbStrip slides={view.playable.slice(0, 4)} onFailed={onFailed} />
        </aside>
      </div>
    </div>
  );
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select") !== null);
}

/**
 * The side thirds and the TV buttons never take focus from a click or a tap: a focused control
 * would keep the TV controls on screen. The keyboard still reaches them with Tab.
 */
function keepFocusAway(event: MouseEvent) {
  event.preventDefault();
}

/** Phones: who shared it and when, the time left on this photo, where we are, and Add yours. */
function PhoneCaption({
  slide,
  index,
  count,
  paused,
  running,
}: {
  slide: Slide;
  index: number;
  count: number;
  paused: boolean;
  running: boolean;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 bg-linear-to-t from-cocoa via-cocoa/80 to-transparent px-5 pt-24 pb-[max(20px,env(safe-area-inset-bottom))] tv:hidden">
      {/* Announced only while paused: a slideshow that reads itself out every six seconds is noise. */}
      <div aria-live={paused ? "polite" : "off"}>
        <div key={slide.id} className="flex animate-caption-in flex-col gap-1.5">
          {/* Shared without a name: nothing in its place. */}
          {slide.by ? <p className="m-0 truncate font-serif text-[26px] leading-tight italic">Shared by {slide.by}</p> : null}
          <p className="m-0 truncate text-[11px] tracking-[0.2em] text-ember uppercase">{slide.detail}</p>
        </div>
      </div>

      {count > 1 ? (
        <div className="mt-4 h-0.5 overflow-hidden rounded-full bg-white/15 motion-reduce:hidden">
          {/* The time left on this photo. It stops when the slideshow does. */}
          <div
            key={slide.id}
            className="h-full animate-countdown rounded-full bg-white/70"
            style={{ animationDuration: `${INTERVAL_MS}ms`, animationPlayState: running ? "running" : "paused" }}
          />
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-4">
        <p className="m-0 text-[11px] tracking-[0.24em] text-mist tabular-nums">
          <span className="sr-only">Photo </span>
          {index + 1}
          <span aria-hidden> / </span>
          <span className="sr-only"> of </span>
          {count}
        </p>
        <AddYours />
      </div>
    </div>
  );
}

/** The TV: the caption bar along the bottom of the photo. */
function TvCaption({ slide, paused }: { slide: Slide; paused: boolean }) {
  return (
    <div
      aria-live={paused ? "polite" : "off"}
      className="absolute inset-x-0 bottom-0 z-20 hidden items-center justify-between gap-24 bg-cocoa/80 px-24 py-20 tv:flex"
    >
      {/* Shared without a name: nothing in its place, the line kept empty so the bar keeps its height
          (one line: 1.5em at this line height, which iOS 15 understands, unlike `lh`). */}
      <p
        key={slide.id}
        className="m-0 min-h-[1.5em] min-w-0 animate-caption-in truncate font-serif text-[max(15px,calc(var(--spacing)*26))] leading-normal italic"
      >
        {slide.by ? `Shared by ${slide.by}` : null}
      </p>
      <p
        key={`${slide.id}-detail`}
        className="m-0 shrink-0 animate-caption-in text-[max(11px,calc(var(--spacing)*13))] tracking-[0.2em] text-ember uppercase"
      >
        {slide.detail}
      </p>
    </div>
  );
}

/** Phones: the monogram, pause and close, over a soft shade at the top of the photo. */
function PhoneBar({ paused, canPause, onTogglePause }: { paused: boolean; canPause: boolean; onTogglePause: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between bg-linear-to-b from-cocoa/85 to-transparent pt-[max(8px,env(safe-area-inset-top))] pr-2 pb-10 pl-5 tv:hidden">
      <p className="m-0 font-script text-[30px] leading-none text-ember">{couple.monogram}</p>
      <div className="flex items-center">
        {canPause ? (
          <button
            type="button"
            aria-label={paused ? "Play the slideshow" : "Pause the slideshow"}
            onClick={onTogglePause}
            className="press flex size-11 cursor-pointer items-center justify-center rounded-full text-white"
          >
            <PlayPause paused={paused} className="size-[18px]" />
          </button>
        ) : null}
        <Link
          href="/album"
          aria-label="Close the slideshow"
          className="press flex size-11 items-center justify-center rounded-full text-white no-underline"
        >
          <Icon name="close" size={22} strokeWidth={1.6} />
        </Link>
      </div>
    </div>
  );
}

/** Pause turns into play and back, crossing over rather than swapping. */
function PlayPause({ paused, className }: { paused: boolean; className: string }) {
  const glyph = "absolute transition-[opacity,scale] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]";
  return (
    <span className={`relative grid place-items-center ${className}`}>
      <PauseGlyph className={`${glyph} size-full ${paused ? "scale-50 opacity-0" : "scale-100 opacity-100"}`} />
      <PlayGlyph className={`${glyph} size-full ${paused ? "scale-100 opacity-100" : "scale-50 opacity-0"}`} />
    </span>
  );
}

function TvButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={keepFocusAway}
      onClick={onClick}
      className="press flex size-[max(44px,calc(var(--spacing)*44))] cursor-pointer items-center justify-center rounded-full bg-cocoa/75 text-white shadow-[var(--shadow-pill-dark)] backdrop-blur-sm hover:bg-cocoa"
    >
      {children}
    </button>
  );
}

function AddYours({ className = "" }: { className?: string }) {
  return (
    <PillLink href="/album" variant="ember" className={className}>
      <span className="flex items-center gap-2.5">
        <Icon name="camera" size={15} />
        Add yours
      </span>
    </PillLink>
  );
}

/** The TV: the four newest photos. Lazy, so phones (where it is hidden) never load them. */
function ThumbStrip({ slides, onFailed }: { slides: Slide[]; onFailed: (id: string) => void }) {
  return (
    <ul aria-label="Recently shared" className="m-0 grid w-full list-none grid-cols-4 gap-6 p-0">
      {[0, 1, 2, 3].map((slot) => {
        const slide = slides[slot];
        return (
          <li key={slide?.id ?? `empty-${slot}`} className={`relative aspect-square overflow-hidden ${slot % 2 ? "bg-mocha/75" : "bg-mocha"}`}>
            {slide ? (
              <SlideImage slide={slide} className="animate-slide-fade" onError={() => onFailed(slide.id)} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
