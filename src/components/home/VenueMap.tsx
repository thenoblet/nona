"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export type MapPlace = {
  number: number;
  label: string;
  name: string;
  lat: number;
  lng: number;
  directionsUrl: string;
};

/** Esri's satellite imagery: free with attribution, no API key. */
const IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const pinSvg = `<svg width="34" height="44" viewBox="-17 -44 34 44" aria-hidden="true"><path d="M0 0C0 0-16-14-16-27a16 16 0 0 1 32 0C16-14 0 0 0 0z" fill="#3D2927" stroke="#fff" stroke-width="2"/><circle cx="0" cy="-27" r="9.5" fill="#E87F39"/></svg>`;

/**
 * A real satellite map of Tepa with a numbered pin for each place, and an optional
 * note laid over the top (the nearby landmarks).
 * Leaflet loads in the browser only; the frame keeps its size while it does.
 */
export function VenueMap({
  places,
  note,
  label,
}: {
  places: MapPlace[];
  note?: { eyebrow: string; text: string };
  label: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(places);

  useEffect(() => {
    const list: MapPlace[] = JSON.parse(key);
    let map: import("leaflet").Map | undefined;
    let cancelled = false;

    import("leaflet").then((leaflet) => {
      if (cancelled || !frame.current) return;
      // On phones, one finger keeps scrolling the page; pinch or the buttons zoom the map.
      const touch = window.matchMedia("(pointer: coarse)").matches;
      map = leaflet.map(frame.current, {
        scrollWheelZoom: false,
        dragging: !touch,
        maxZoom: 19,
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix(false);
      leaflet.tileLayer(IMAGERY, {
        maxZoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      }).addTo(map);

      const bounds = leaflet.latLngBounds([]);
      for (const place of list) {
        const icon = leaflet.divIcon({
          className: "nona-pin",
          html: `${pinSvg}<span class="nona-pin__n">${place.number}</span><span class="nona-pin__tag">${place.label}</span>`,
          iconSize: [34, 44],
          iconAnchor: [17, 44],
          popupAnchor: [0, -46],
        });
        leaflet.marker([place.lat, place.lng], { icon, title: place.name, alt: place.name })
          .addTo(map)
          .bindPopup(
            `<span class="nona-pop__eyebrow">${place.label}</span><strong class="nona-pop__name">${place.name}</strong><a class="nona-pop__link" href="${place.directionsUrl}" target="_blank" rel="noopener noreferrer">Get directions</a>`,
            { className: "nona-pop", closeButton: false, maxWidth: 240 },
          );
        bounds.extend([place.lat, place.lng]);
      }
      // Labels sit to the right of each marker, so leave more room on that side.
      map.fitBounds(bounds, { paddingTopLeft: [24, 60], paddingBottomRight: [110, 24], maxZoom: 18 });
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [key]);

  return (
    <div className="relative">
      <div
        ref={frame}
        role="region"
        aria-label={label}
        className="nona-map aspect-[4/5] w-full overflow-hidden rounded-[calc(var(--radius-paper)-4px)] bg-tray sm:aspect-[5/4]"
      />
      {note ? (
        <p className="pointer-events-none absolute right-3 bottom-8 z-[500] m-0 flex max-w-[70%] flex-col gap-0.5 rounded-[3px] bg-white/92 px-3.5 py-2.5 text-right shadow-[var(--shadow-paper)]">
          <span className="text-[10px] uppercase tracking-[0.24em] text-mocha">{note.eyebrow}</span>
          <span className="font-serif text-lg leading-tight text-cocoa italic">{note.text}</span>
        </p>
      ) : null}
    </div>
  );
}
