"use client";

import { useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { songs } from "@/content/songs";
import { Icon, PauseGlyph, PlayGlyph } from "@/components/ui/Icon";
import { useMusic } from "./MusicProvider";
import { placeSpot, readSpot, snapSpot, type Room, type Side, type Spot } from "./spot";
import { PEEK_MS, openPill, pillShown, tuckReducer } from "./tuck";

function clock(time: number) {
  const seconds = Math.max(0, Math.floor(time));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Whether the guest tucked the player away, kept across pages and visits. */
const TUCKED_KEY = "nona:music-tucked";
/** Whether this browser has shown the note on where the music went, the first time it was tucked. */
const HINT_KEY = "nona:music-tuck-hint-seen";
/** Where the guest moved the round button to, kept across pages and visits (src/components/music/spot.ts). */
const SPOT_KEY = "nona:music-spot";
/** Phones, where the round button can be moved; laptops keep it in the corner. */
const PHONE = "(width < 64rem)";
/** The round button's size, and how far a finger moves before a tap becomes a drag. */
const BUTTON_PX = 54;
const DRAG_PX = 8;
/** Space kept between the button and the header above, or the tab bar below. */
const CLEARANCE_PX = 12;
/** How long the button takes to glide to its side once let go. */
const GLIDE_MS = 250;
/** How long that note shows. */
const HINT_MS = 4000;
/** How far to the right the pill has to be dragged to tuck it away. */
const SWIPE_PX = 48;
/** The progress ring's length: a circle of radius 25. */
const RING = 2 * Math.PI * 25;

/** Browser storage can be missing or refuse (private windows, blocked site data): then nothing is remembered. */
function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function storedText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeText(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; the button still sits where it was put until the page is left.
  }
}

/**
 * The band the moved button may rest in on this screen: below the sticky header and above the
 * phone tab bar (measured as laid out, so a bar that has stepped aside for the keyboard still counts).
 */
function measureRoom(): Room {
  // Below the notch or the status bar too, where a header has scrolled away.
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;top:0;visibility:hidden;padding-top:env(safe-area-inset-top)";
  document.body.append(probe);
  let headerBottom = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  for (const header of document.querySelectorAll("header")) {
    const position = getComputedStyle(header).position;
    if (position === "sticky" || position === "fixed") headerBottom = Math.max(headerBottom, header.getBoundingClientRect().bottom);
  }
  const bar = document.querySelector<HTMLElement>("[data-tab-bar]");
  const barHeight = bar && getComputedStyle(bar).display !== "none" ? bar.offsetHeight : 0;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    topLimit: Math.max(0, headerBottom) + CLEARANCE_PX,
    bottomLimit: window.innerHeight - barHeight - CLEARANCE_PX,
  };
}

/**
 * Where the moved button sits on this screen, whether its playlist and note open below it, and how
 * tall the playlist may be there.
 */
type Placed = { side: Side; topPx: number; below: boolean; roomPx: number };

function place(spot: Spot | null): Placed | null {
  if (!spot || !window.matchMedia(PHONE).matches) return null;
  const room = measureRoom();
  const placed = placeSpot(spot, BUTTON_PX, room);
  if (!placed) return null;
  // The playlist card and the first-tuck note open on whichever side of the button has more room.
  const roomAbove = placed.topPx - room.topLimit;
  const roomBelow = room.bottomLimit - placed.topPx - BUTTON_PX;
  return { ...placed, below: roomBelow > roomAbove, roomPx: Math.max(roomAbove, roomBelow) - CLEARANCE_PX };
}

function remember(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Not remembered; the player still works.
  }
}

/** Four bars that dance while music plays, and pulse softly while it loads. */
export function Bars({ playing, loading = false }: { playing: boolean; loading?: boolean }) {
  const bars: [number, number][] = [
    [14, 0],
    [20, 150],
    [12, 300],
    [18, 450],
  ];
  return (
    <span className={`flex items-end gap-[3px] ${loading ? "animate-pulse" : ""}`} aria-hidden>
      {bars.map(([height, delay]) => (
        <span
          key={delay}
          className="block w-[3px] origin-bottom rounded-sm bg-ember"
          style={{
            height,
            animation: playing && !loading ? `bar 900ms ease-in-out ${delay}ms infinite` : undefined,
            transform: playing && !loading ? undefined : "scaleY(0.45)",
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
 *
 * The › at its end, or a swipe to the right, tucks the pill into a round button with the dancing
 * bars and a ring that fills as the song plays; a tap opens it again. When a new song starts while
 * it is tucked, the pill opens for a few seconds to show the song's name, then tucks itself back.
 *
 * On phones the round button can be dragged anywhere; let go, it glides to the nearer side at that
 * height, clear of the header and the tab bar, and the pill opens, tucks and peeks from there. On
 * the left the pill mirrors: its ‹ comes first, and a swipe to the left tucks it.
 */
export function MusicPlayer({ autoplay = false }: { autoplay?: boolean }) {
  const music = useMusic();
  const [open, setOpen] = useState(false);
  // The playlist card's contents are drawn the first time it opens, not sent with every page: most
  // guests never open it, and every song in it would add to each page's HTML.
  const [playlistOpened, setPlaylistOpened] = useState(false);
  // Where the guest is dragging the seek bar. The audio only moves on release:
  // seeking on every step re-downloads the song again and again on mobile data.
  const [scrub, setScrub] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const tuckedButton = useRef<HTMLButtonElement>(null);
  const song = songs[music.track];

  const [tuck, dispatch] = useReducer(tuckReducer, openPill);
  const [hint, setHint] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  // Tucking and opening glide, but what this browser remembered shows as it is, with no animation.
  const [animated, setAnimated] = useState(false);
  // Where focus goes once the pill or the round button is on screen: where the guest's hand was.
  // The hidden one is `inert` (out of reach of taps, keys and screen readers) rather than
  // `invisible`, which would refuse focus at the very start of its fade in.
  const focusNext = useRef<"play" | "tucked" | null>(null);
  const lastTrack = useRef(music.track);
  // A swipe on the pill: where it started, and how far right it has gone.
  const swipeStart = useRef<{ across: number; down: number } | null>(null);
  const swiping = useRef(false);
  const [swipe, setSwipe] = useState(0);
  const showPill = pillShown(tuck);

  // Where the guest moved the round button (as this browser remembers it), and where that is on
  // this screen (none: the corner).
  const spot = useRef<Spot | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  // A drag of the round button: where it started, where on the button the finger is, and how far it
  // has gone.
  const dragStart = useRef<{ across: number; down: number; grabX: number; grabY: number } | null>(null);
  const dragging = useRef(false);
  const [drag, setDrag] = useState<{ across: number; down: number } | null>(null);
  // Where the button's middle was let go, so it can glide from there to its side.
  const droppedAt = useRef<{ x: number; y: number } | null>(null);
  const side: Side = placed?.side ?? "right";
  const onLeft = side === "left";

  useLayoutEffect(() => {
    if (remembered(TUCKED_KEY)) dispatch({ type: "restore", tucked: true });
    const frame = requestAnimationFrame(() => setAnimated(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Put the button at its remembered spot, and again whenever the screen changes size or turns.
  useLayoutEffect(() => {
    spot.current = readSpot(storedText(SPOT_KEY));
    const update = () => setPlaced(place(spot.current));
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Let go: glide from where the finger left it to its side.
  useLayoutEffect(() => {
    const dropped = droppedAt.current;
    const button = tuckedButton.current;
    droppedAt.current = null;
    if (!dropped || !button || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const now = button.getBoundingClientRect();
    const across = dropped.x - (now.left + now.width / 2);
    const down = dropped.y - (now.top + now.height / 2);
    button.animate([{ translate: `${across}px ${down}px` }, { translate: "0 0" }], {
      duration: GLIDE_MS,
      easing: "cubic-bezier(0.16,1,0.3,1)",
    });
  }, [placed]);

  // A new song while tucked: the pill peeks, and screen readers hear its name.
  useEffect(() => {
    if (lastTrack.current === music.track) return;
    lastTrack.current = music.track;
    // Someone using the player by keyboard keeps it as it is, rather than lose their place.
    if (!tuck.tucked || root.current?.contains(document.activeElement)) return;
    dispatch({ type: "songChanged" });
    setAnnouncement(`Now playing ${songs[music.track].title}`);
  }, [music.track, tuck.tucked]);

  useEffect(() => {
    if (!tuck.peeking) return;
    const timer = setTimeout(() => dispatch({ type: "peekEnded" }), PEEK_MS);
    return () => clearTimeout(timer);
  }, [tuck.peeking, music.track]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    if (focusNext.current === "play") playButton.current?.focus();
    if (focusNext.current === "tucked") tuckedButton.current?.focus();
    focusNext.current = null;
  }, [tuck.tucked]);

  function tuckAway() {
    setOpen(false);
    dispatch({ type: "tuck" });
    remember(TUCKED_KEY, true);
    focusNext.current = "tucked";
    if (!remembered(HINT_KEY)) {
      remember(HINT_KEY, true);
      setHint(true);
    }
  }

  function openAgain() {
    dispatch({ type: "open" });
    remember(TUCKED_KEY, false);
    setHint(false);
    focusNext.current = "play";
  }

  /** A tap or focus on the pill while it peeks keeps it open. */
  function keepIfPeeking() {
    if (!tuck.peeking) return;
    dispatch({ type: "touched" });
    remember(TUCKED_KEY, false);
  }

  function onSwipeStart(event: ReactPointerEvent<HTMLDivElement>) {
    swipeStart.current = { across: event.clientX, down: event.clientY };
    swiping.current = false;
  }

  function onSwipeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = swipeStart.current;
    if (!start) return;
    // Towards the side the player sits on: right in the corner, left when it was moved to the left.
    const across = (event.clientX - start.across) * (onLeft ? -1 : 1);
    const down = event.clientY - start.down;
    if (!swiping.current) {
      // Mostly up or down: the page is scrolling, not a swipe.
      if (Math.abs(down) > 10 && Math.abs(down) > Math.abs(across)) {
        swipeStart.current = null;
        return;
      }
      if (across < 8) return;
      swiping.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setSwipe(Math.max(0, across));
  }

  function onDragStart(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !window.matchMedia(PHONE).matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    dragStart.current = {
      across: event.clientX,
      down: event.clientY,
      grabX: event.clientX - (box.left + box.width / 2),
      grabY: event.clientY - (box.top + box.height / 2),
    };
    dragging.current = false;
    // Hold on to the pointer from the start, so a quick flick that leaves the button still drags it.
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onDragMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStart.current;
    if (!start) return;
    const moved = { across: event.clientX - start.across, down: event.clientY - start.down };
    if (!dragging.current) {
      if (Math.hypot(moved.across, moved.down) < DRAG_PX) return;
      dragging.current = true;
      setHint(false);
    }
    setDrag(moved);
  }

  function onDragEnd(event: ReactPointerEvent<HTMLButtonElement>) {
    const start = dragStart.current;
    if (dragging.current && start) {
      // The button's middle under the finger (not its box, which the lift's scale skews).
      const middle = { x: event.clientX - start.grabX, y: event.clientY - start.grabY };
      const next = snapSpot(middle, BUTTON_PX, measureRoom());
      droppedAt.current = middle;
      storeText(SPOT_KEY, JSON.stringify(next));
      spot.current = next;
      setPlaced(place(next));
    }
    dragStart.current = null;
    setDrag(null);
  }

  function onSwipeEnd() {
    if (swiping.current && swipe >= SWIPE_PX) tuckAway();
    swipeStart.current = null;
    setSwipe(0);
  }

  useEffect(() => {
    if (autoplay) music.requestAutoplay();
    // Run once on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoplay]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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

  const shown = scrub ?? music.position;
  const frac = music.duration > 0 ? Math.min(1, shown / music.duration) : 0;
  const loading = music.playing && music.buffering;

  function commitSeek() {
    if (scrub === null) return;
    music.seek(scrub);
    setScrub(null);
  }

  return (
    <div
      ref={root}
      data-music-player
      data-side={placed ? side : undefined}
      className={placed ? "fixed z-50" : "relative"}
      style={
        placed
          ? {
              top: placed.topPx,
              [side]: `calc(14px + env(safe-area-inset-${side}))`,
            }
          : undefined
      }
    >
      <div
        id="playlist-card"
        role="region"
        aria-label="Our playlist"
        // The card fits the room above the pill (or, moved up or down the screen, the room on its
        // side) and scrolls inside, however long the playlist grows.
        style={placed ? { maxHeight: placed.roomPx } : undefined}
        className={`absolute overflow-y-auto overscroll-contain ${onLeft ? "left-0" : "right-0"} ${
          placed?.below ? `top-[calc(100%+12px)] ${onLeft ? "origin-top-left" : "origin-top-right"}` : `bottom-[calc(100%+12px)] ${onLeft ? "origin-bottom-left" : "origin-bottom-right"}`
        } max-h-[calc(100dvh-var(--tabbar-space)-112px)] w-[min(340px,calc(100vw-32px))] rounded-[var(--radius-paper)] bg-white px-2.5 pt-1.5 pb-2 text-cocoa max-sm:w-[min(296px,calc(100vw-32px))] max-sm:px-2 max-sm:pt-1 max-sm:pb-1.5 shadow-[0_1px_2px_rgb(61_41_39/0.08),0_18px_44px_rgb(61_41_39/0.18)] transition-[opacity,scale,translate,visibility] ${
          open ? `visible translate-y-0 scale-100 opacity-100 ${opening}` : `invisible translate-y-1.5 scale-95 opacity-0 ${closing}`
        }`}
      >
        {playlistOpened ? (
          <>
            {/* Phones get a smaller card: everything in it a size down, every button still easy to tap. */}
            <div className="flex items-center justify-between gap-2 border-b border-hairline pb-1 pl-2 max-sm:pb-0.5">
              <span className="font-script text-[26px] leading-tight max-sm:text-[21px]">Songs for the two of us</span>
              <button
                type="button"
                onClick={close}
                aria-label="Close our playlist"
                className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-cocoa transition-colors hover:bg-tray max-sm:size-10"
              >
                <Icon name="close" size={16} strokeWidth={1.7} />
              </button>
            </div>

            <div className="flex flex-col border-b border-hairline px-2 pt-2.5 pb-2 max-sm:pt-1.5 max-sm:pb-1.5">
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
                  value={Math.floor(shown)}
                  onChange={(event) => setScrub(Number(event.target.value))}
                  onPointerUp={commitSeek}
                  onPointerCancel={commitSeek}
                  onTouchEnd={commitSeek}
                  onKeyUp={commitSeek}
                  onBlur={commitSeek}
                  aria-label={`Position in ${song.title}`}
                  aria-valuetext={`${clock(shown)} of ${clock(music.duration)}`}
                />
              </div>
              <div className="flex justify-between text-[11px] tracking-wide text-mocha max-sm:text-[10px]">
                <span>{clock(shown)}</span>
                <span>{clock(music.duration)}</span>
              </div>
              <div className="-mt-1 flex items-center justify-center gap-6 max-sm:gap-5">
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
                  className="press flex size-12 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)] max-sm:size-11"
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

            <ol className="m-0 flex list-none flex-col gap-0.5 p-0 pt-1.5 max-sm:gap-0 max-sm:pt-1">
              {songs.map((listed, index) => {
                const current = index === music.track;
                const on = current && music.playing;
                return (
                  <li key={listed.id}>
                    <button
                      type="button"
                      onClick={() => (current ? music.toggle() : music.playTrack(index))}
                      aria-pressed={on}
                      aria-label={`${on ? "Pause" : "Play"} ${listed.title}`}
                      className={`flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-[var(--radius-paper)] border-0 px-2 py-1.5 text-left transition-colors hover:bg-blush max-sm:min-h-11 max-sm:gap-2.5 max-sm:py-1 ${current ? "bg-blush" : "bg-transparent"}`}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-halo text-ember max-sm:size-7">
                        {on ? <Bars playing loading={loading} /> : <PlayGlyph size={11} />}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-serif text-[17px] leading-tight italic max-sm:text-[15px]">{listed.title}</span>
                        <span className="truncate text-[11px] tracking-wide text-mocha max-sm:text-[10px]">{listed.artist}</span>
                      </span>
                      <span className="shrink-0 text-[11px] tracking-wide text-mocha max-sm:text-[10px]">{clock(listed.seconds)}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        ) : null}
      </div>

      <div
        onPointerDown={(event) => {
          keepIfPeeking();
          onSwipeStart(event);
        }}
        onPointerMove={onSwipeMove}
        onPointerUp={onSwipeEnd}
        onPointerCancel={() => {
          swipeStart.current = null;
          swiping.current = false;
          setSwipe(0);
        }}
        // A swipe that ends on a button is not a tap on it.
        onClickCapture={(event) => {
          if (!swiping.current) return;
          swiping.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        onFocus={keepIfPeeking}
        inert={!showPill}
        style={swipe > 0 ? { translate: `${onLeft ? -swipe : swipe}px 0`, opacity: Math.max(0.3, 1 - swipe / 160), transition: "none" } : undefined}
        className={`flex min-h-12 ${onLeft ? "origin-bottom-left" : "origin-bottom-right"} touch-pan-y items-center gap-0.5 rounded-full bg-white p-0.5 pl-1 text-cocoa shadow-[var(--shadow-pill-white)] sm:min-h-14 sm:gap-1 sm:p-2 ${
          animated ? "transition-[opacity,scale,translate] motion-reduce:transition-none" : ""
        } ${showPill ? `scale-100 opacity-100 ${opening}` : `pointer-events-none absolute ${onLeft ? "left-0" : "right-0"} bottom-0 scale-50 opacity-0 ${closing}`}`}
      >
        <button
          ref={playButton}
          type="button"
          onClick={music.toggle}
          aria-pressed={music.playing}
          aria-label={music.playing ? "Pause our song" : "Play our song"}
          className="flex min-h-11 cursor-pointer items-center gap-2.5 border-0 bg-transparent pr-1.5 text-left sm:gap-3 sm:pr-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-halo sm:size-10">
            <Bars playing={music.playing} loading={loading} />
          </span>
          <span className="dock-label flex min-w-0 flex-col">
            <span className="text-[10px] uppercase tracking-[0.18em] text-mocha sm:text-[11px]">
              {loading ? "Loading…" : music.playing ? "Now playing" : "Play our song"}
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
          onClick={() => {
            setPlaylistOpened(true);
            setOpen((isOpen) => !isOpen);
          }}
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
        <button
          type="button"
          onClick={tuckAway}
          aria-label="Make the music player smaller"
          className={`flex h-11 w-8 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-mocha ${onLeft ? "order-first" : ""}`}
        >
          <span className="flex size-[30px] items-center justify-center rounded-full transition-colors hover:bg-tray">
            <Icon name="chevron" size={16} strokeWidth={1.8} className={onLeft ? "rotate-90" : "-rotate-90"} />
          </span>
        </button>
      </div>

      {/* Tucked: a round button with the dancing bars, or a play triangle when paused, and a ring that fills as the song plays. */}
      <button
        ref={tuckedButton}
        type="button"
        onClick={openAgain}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={() => {
          dragStart.current = null;
          dragging.current = false;
          setDrag(null);
        }}
        // A drag is not a tap: letting go never opens the pill.
        onClickCapture={(event) => {
          if (!dragging.current) return;
          dragging.current = false;
          event.preventDefault();
          event.stopPropagation();
        }}
        inert={showPill}
        style={
          drag
            ? {
                translate: `${drag.across}px ${drag.down}px`,
                scale: "1.1",
                boxShadow: "0 2px 4px rgb(61 41 39 / 0.10), 0 22px 44px rgb(61 41 39 / 0.34)",
                transition: "none",
              }
            : undefined
        }
        aria-label={`Open the music player. ${music.playing ? "Now playing" : "Paused"}: ${song.title}`}
        className={`flex size-[54px] ${onLeft ? "origin-bottom-left" : "origin-bottom-right"} cursor-pointer touch-none items-center justify-center rounded-full border-0 bg-white p-0 shadow-[var(--shadow-pill-white)] ${
          animated ? "transition-[opacity,scale] motion-reduce:transition-none" : ""
        } ${showPill ? `pointer-events-none absolute ${onLeft ? "left-0" : "right-0"} bottom-0 scale-50 opacity-0 ${closing}` : `relative scale-100 opacity-100 ${opening}`}`}
      >
        <svg aria-hidden viewBox="0 0 54 54" className="absolute inset-0 -rotate-90">
          <circle cx="27" cy="27" r="25" fill="none" stroke="var(--color-tray)" strokeWidth="2.5" />
          <circle
            cx="27"
            cy="27"
            r="25"
            fill="none"
            stroke="var(--color-ember)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={RING}
            strokeDashoffset={RING * (1 - frac)}
            className={frac > 0 ? "" : "opacity-0"}
          />
        </svg>
        <span className="flex size-9 items-center justify-center rounded-full bg-halo text-ember">
          {music.playing ? <Bars playing loading={loading} /> : <PlayGlyph size={13} className="translate-x-px" />}
        </span>
      </button>

      {/* The first time it is tucked: where the music went. */}
      <p
        aria-hidden
        className={`pointer-events-none absolute ${onLeft ? "left-0 after:left-5" : "right-0 after:right-5"} ${
          placed?.below ? "top-[calc(100%+12px)] after:bottom-full after:border-b-cocoa" : "bottom-[calc(100%+12px)] after:top-full after:border-t-cocoa"
        } m-0 w-max max-w-[220px] rounded-xl bg-cocoa px-3.5 py-2.5 text-[13px] leading-snug text-white shadow-[var(--shadow-pill-white)] transition-opacity duration-300 after:absolute after:border-6 after:border-transparent ${
          hint && !showPill ? "opacity-100" : "opacity-0"
        }`}
      >
        {music.playing ? "Music is still playing. Tap here to open it." : "Tap here to open the music."}
      </p>
      <p aria-live="polite" className="sr-only">
        {tuck.tucked ? announcement : ""}
      </p>
    </div>
  );
}
