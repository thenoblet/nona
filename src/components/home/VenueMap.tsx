"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

export type MapPlace = {
  n: number;
  label: string;
  name: string;
  lat: number;
  lng: number;
  directionsUrl: string;
};

/** Esri's satellite imagery: free with attribution, no API key. */
const IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

const pinSvg = `<svg width="34" height="44" viewBox="-17 -44 34 44" aria-hidden="true"><path d="M0 0C0 0-16-14-16-27a16 16 0 0 1 32 0C16-14 0 0 0 0z" fill="#3D2927" stroke="#fff" stroke-width="2"/><circle cx="0" cy="-27" r="9.5" fill="#E87F39"/></svg>`;

export type MapLandmark = { name: string; lat: number; lng: number };

/**
 * A real satellite map of Tepa: a numbered pin for each place and a small marker per landmark.
 * Leaflet loads in the browser only; the frame keeps its size while it does.
 */
export function VenueMap({
  places,
  landmarks = [],
  label,
}: {
  places: MapPlace[];
  landmarks?: MapLandmark[];
  label: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const key = JSON.stringify([places, landmarks]);

  useEffect(() => {
    const [list, marks]: [MapPlace[], MapLandmark[]] = JSON.parse(key);
    let map: import("leaflet").Map | undefined;
    let cancelled = false;

    import("leaflet").then((L) => {
      if (cancelled || !el.current) return;
      // On phones, one finger keeps scrolling the page; pinch or the buttons zoom the map.
      const touch = window.matchMedia("(pointer: coarse)").matches;
      map = L.map(el.current, {
        scrollWheelZoom: false,
        dragging: !touch,
        maxZoom: 19,
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix(false);
      L.tileLayer(IMAGERY, {
        maxZoom: 19,
        attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
      }).addTo(map);

      const bounds = L.latLngBounds([]);
      for (const p of list) {
        const icon = L.divIcon({
          className: "nona-pin",
          html: `${pinSvg}<span class="nona-pin__n">${p.n}</span><span class="nona-pin__tag">${p.label}</span>`,
          iconSize: [34, 44],
          iconAnchor: [17, 44],
          popupAnchor: [0, -46],
        });
        L.marker([p.lat, p.lng], { icon, title: p.name, alt: p.name })
          .addTo(map)
          .bindPopup(
            `<span class="nona-pop__eyebrow">${p.label}</span><strong class="nona-pop__name">${p.name}</strong><a class="nona-pop__link" href="${p.directionsUrl}" target="_blank" rel="noopener noreferrer">Get directions</a>`,
            { className: "nona-pop", closeButton: false, maxWidth: 240 },
          );
        bounds.extend([p.lat, p.lng]);
      }
      for (const m of marks) {
        const icon = L.divIcon({
          className: "nona-mark",
          html: `<span class="nona-mark__dot"></span><span class="nona-mark__tag">${m.name}</span>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7],
        });
        L.marker([m.lat, m.lng], { icon, title: m.name, alt: `Landmark: ${m.name}`, interactive: false }).addTo(map);
        bounds.extend([m.lat, m.lng]);
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
    <div
      ref={el}
      role="region"
      aria-label={label}
      className="nona-map aspect-[4/5] w-full overflow-hidden rounded-[calc(var(--radius-paper)-4px)] bg-tray sm:aspect-[5/4]"
    />
  );
}
