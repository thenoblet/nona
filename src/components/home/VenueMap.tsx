"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { googleMapsKeyRefused, loadGoogleMaps, onGoogleMapsKeyRefused } from "./google-maps";
import { fitPadding, googleMapsEmbedUrl, googleMapsSearchUrl, type MapPlace } from "./venue-map";
import { VenueMapController, type VenueMapStatus } from "./venue-map-controller";
import { drawVenueMap, imageryMaxZoom } from "./venue-map-google";

export type { MapPlace } from "./venue-map";

/** How far ahead of the frame, as the page scrolls towards it, Google's script starts loading. */
const LOAD_AHEAD = "300px 0px";


/**
 * A phone or tablet, by its pointer rather than its width: touch is what makes a map's pan and
 * zoom fight the page's scroll, and a narrow window on a computer has no such trouble. The CSS's
 * pointer-coarse variant asks the same question.
 */
const COARSE_POINTER = "(pointer: coarse)";

function watchPointer(onChange: () => void): () => void {
  const query = window.matchMedia(COARSE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Whether the main pointer is a finger. False on the server, so the page renders as on a computer. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    watchPointer,
    () => window.matchMedia(COARSE_POINTER).matches,
    () => false,
  );
}

const PILL =
  "absolute top-3 right-3 inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-white/92 px-4 text-[10px] uppercase tracking-[0.16em] text-cocoa no-underline shadow-[var(--shadow-paper)]";

/**
 * A satellite map of Tepa from Google Maps, with our numbered pin for each place, and an optional
 * note laid over the top (the nearby landmarks). Google's script loads in the browser only, once
 * the frame comes near the screen; until the map is drawn the frame shows a link to the first
 * place (the church) on Google Maps. Without a key, or when Google can't draw the map (the script
 * fails or takes over 10 seconds, or Google refuses the key), the frame shows Google's keyless
 * satellite embed of the church instead, with the same link, also only once near the screen.
 *
 * On a computer the map is interactive, with an "Open in Google Maps" button on it. On a phone it
 * is a preview: one link over the whole frame opens the church in Google Maps (the app, when it is
 * installed), and nothing in the frame pans or zooms.
 */
export function VenueMap({
  places,
  note,
  label,
  apiKey,
}: {
  places: MapPlace[];
  note?: { eyebrow: string; text: string };
  label: string;
  /** The Google Maps browser key, read on the server; without one, nothing loads from Google. */
  apiKey?: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  // What lies over the map, for the opening view to keep the pins clear of.
  const phonePill = useRef<HTMLSpanElement>(null);
  const computerPill = useRef<HTMLAnchorElement>(null);
  const landmarks = useRef<HTMLParagraphElement>(null);
  const [near, setNear] = useState(false);
  const [status, setStatus] = useState<VenueMapStatus>("waiting");
  const preview = useCoarsePointer();
  const placesKey = JSON.stringify(places);
  const googleMapsUrl = googleMapsSearchUrl(places[0]);
  const drawsMap = Boolean(apiKey) && places.length > 0;
  const mapShown = drawsMap && status === "ready";
  const showsEmbed = near && (!drawsMap || status === "failed");

  // Nothing loads from Google, neither the script nor the embed, until the frame comes near the
  // screen. The embed's own loading="lazy" isn't enough: the page streams in hidden first, and
  // browsers load a hidden iframe straight away.
  useEffect(() => {
    const frameElement = frame.current;
    if (!frameElement) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setNear(true);
      },
      { rootMargin: LOAD_AHEAD },
    );
    observer.observe(frameElement);
    return () => observer.disconnect();
  }, []);

  // One controller for this frame's life, kept in a ref: it keeps the map it drew when /home is
  // hidden and shown again (Next keeps visited pages), so a return to /home costs no new map
  // against the key's daily cap, and once Google's map has failed it never tries again.
  const controller = useRef<VenueMapController | null>(null);

  useEffect(() => {
    if (!near || !apiKey || places.length === 0) return;
    controller.current ??= new VenueMapController({
      load: () => loadGoogleMaps(apiKey),
      maxZoom: (libraries, key) => imageryMaxZoom(libraries, (JSON.parse(key) as MapPlace[])[0]),
      draw: ({ libraries, placesKey: key, maxZoom, preview: asPreview, onReady }) => {
        const canvasElement = canvas.current;
        const frameElement = frame.current;
        if (!canvasElement || !frameElement) throw new Error("The map's frame has gone");
        const box = (element: Element | null) => element?.getBoundingClientRect() ?? new DOMRect();
        return drawVenueMap({
          libraries,
          canvas: canvasElement,
          places: JSON.parse(key) as MapPlace[],
          maxZoom,
          backgroundColor: getComputedStyle(frameElement).backgroundColor,
          preview: asPreview,
          padding: fitPadding(
            box(frameElement),
            [box(phonePill.current), box(computerPill.current)],
            [box(landmarks.current)],
          ),
          onReady,
        });
      },
      keyRefused: googleMapsKeyRefused,
      onKeyRefused: onGoogleMapsKeyRefused,
      onStatus: setStatus,
    });
    const shown = controller.current;
    shown.show(placesKey, preview);
    return () => shown.hide();
  }, [near, apiKey, places.length, placesKey, preview]);

  return (
    <div className="relative">
      <div
        ref={frame}
        role="region"
        aria-label={label}
        className="nona-map relative aspect-[4/5] w-full overflow-hidden rounded-[calc(var(--radius-paper)-4px)] bg-tray sm:aspect-[5/4]"
      >
        {/* Phones: the whole frame opens Google Maps, before anything Google drew, so a tap never
            pans or zooms the map here. Shown by CSS, so it is there from the first paint. */}
        <a
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open the church in Google Maps"
          className="absolute inset-0 z-[1] hidden pointer-coarse:block"
        >
          <span ref={phonePill} aria-hidden="true" className={PILL}>
            Tap to open Google Maps
          </span>
        </a>
        {showsEmbed ? (
          <iframe
            src={googleMapsEmbedUrl(places[0])}
            title="Satellite map of the church in Tepa"
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            inert={preview}
            className="absolute inset-0 size-full border-0"
          />
        ) : null}
        {drawsMap ? (
          // Google draws into this; React never puts anything in it. Its own layer, so Google's
          // controls stay under our links. Hidden, and out of reach of taps and the keyboard, until
          // the first tiles are in, and kept out of reach on phones.
          <div
            ref={canvas}
            inert={!mapShown || preview}
            className={`absolute inset-0 isolate transition-opacity duration-500 ${mapShown ? "opacity-100" : "pointer-events-none opacity-0"}`}
          />
        ) : null}
        {/* Computers: the map stays interactive, with Google Maps a click away. */}
        <a
          ref={computerPill}
          href={googleMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`${PILL} z-[1] pointer-coarse:hidden`}
        >
          Open in Google Maps
        </a>
      </div>
      {note ? (
        <p
          ref={landmarks}
          className="pointer-events-none absolute right-3 bottom-8 z-[500] m-0 flex max-w-[70%] flex-col gap-0.5 rounded-[3px] bg-white/92 px-3.5 py-2.5 text-right shadow-[var(--shadow-paper)]"
        >
          <span className="text-[10px] uppercase tracking-[0.24em] text-mocha">{note.eyebrow}</span>
          <span className="font-serif text-lg leading-tight text-cocoa italic">{note.text}</span>
        </p>
      ) : null}
    </div>
  );
}
