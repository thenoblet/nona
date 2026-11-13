/** A place with a pin on the venue map. */
export type MapPlace = {
  number: number;
  label: string;
  name: string;
  lat: number;
  lng: number;
  directionsUrl: string;
};

/** The edges of a box on screen, as getBoundingClientRect gives them. */
export type ScreenBox = { top: number; right: number; bottom: number; left: number };

/**
 * The zoom the map stops at when Google can't say how far its imagery goes, and the closest the
 * opening view comes, so both places show with a little of Tepa around them.
 */
export const DEFAULT_MAX_ZOOM = 18;

const PIN_SVG = `<svg width="34" height="44" viewBox="-17 -44 34 44" aria-hidden="true"><path d="M0 0C0 0-16-14-16-27a16 16 0 0 1 32 0C16-14 0 0 0 0z" fill="#3D2927" stroke="#fff" stroke-width="2"/><circle cx="0" cy="-27" r="9.5" fill="#E87F39"/></svg>`;

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text made safe to put inside HTML, between tags or in a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/**
 * A place's numbered pin and its name tag: one button, named with the tag it shows and then the
 * place ("Church: Assemblies of God…"), so a guest using voice control can say what they see.
 */
export function pinHtml(place: MapPlace): string {
  return (
    `<button type="button" class="nona-pin" aria-label="${escapeHtml(`${place.label}: ${place.name}`)}" aria-expanded="false">` +
    PIN_SVG +
    `<span class="nona-pin__n">${escapeHtml(String(place.number))}</span>` +
    `<span class="nona-pin__tag">${escapeHtml(place.label)}</span>` +
    `</button>`
  );
}

/** The popup a pin opens, hidden until then: what the place is, its name, and directions to it. */
export function popupHtml(place: MapPlace): string {
  return (
    `<div class="nona-pop" hidden>` +
    `<span class="nona-pop__eyebrow">${escapeHtml(place.label)}</span>` +
    `<strong class="nona-pop__name">${escapeHtml(place.name)}</strong>` +
    `<a class="nona-pop__link" href="${escapeHtml(place.directionsUrl)}" target="_blank" rel="noopener noreferrer">Get directions</a>` +
    `</div>`
  );
}

/** Google Maps searching for the place's pin, or for Tepa when no place has one. */
export function googleMapsSearchUrl(place: { lat: number; lng: number } | undefined): string {
  const query = place ? `${place.lat},${place.lng}` : encodeURIComponent("Tepa, Ghana");
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

/** A pin's height above its point, in pixels (its SVG is 44 tall, tip at the bottom). */
const PIN_HEIGHT = 44;
/** Room left between a pin and what lies over the map. */
const CLEARANCE = 8;
/** The opening view's usual room around the places: more on the right, where the name tags sit. */
const BASE_FIT_PADDING = { top: 60, right: 110, bottom: 24, left: 24 };

/**
 * The room the opening view keeps around the places, in pixels, so every pin shows clear of what
 * lies over the map: the Google Maps pill along its top, the landmarks note along its bottom. A
 * guest on a phone can't pan the map to find a pin hidden under them. Hidden elements, which
 * have no size, don't count.
 */
export function fitPadding(
  frame: ScreenBox,
  overTop: ScreenBox[],
  overBottom: ScreenBox[],
): { top: number; right: number; bottom: number; left: number } {
  const shown = (box: ScreenBox) => box.bottom > box.top;
  const top = Math.max(
    BASE_FIT_PADDING.top,
    ...overTop.filter(shown).map((box) => box.bottom - frame.top + PIN_HEIGHT + CLEARANCE),
  );
  const bottom = Math.max(
    BASE_FIT_PADDING.bottom,
    ...overBottom.filter(shown).map((box) => frame.bottom - box.top + CLEARANCE),
  );
  return { ...BASE_FIT_PADDING, top, bottom };
}

/** The keyless embed's zoom on a place: the church and its street, with Tepa around it. */
const EMBED_ZOOM = 17;
/** The keyless embed's zoom on Tepa as a whole, when no place has a pin. */
const EMBED_TOWN_ZOOM = 15;

/**
 * Google's keyless embed, in satellite (t=k), of the place's pin, or of Tepa when no place has
 * one: what the venue map falls back to. It needs no key, has no billing and counts towards no
 * quota, but shows only the one place.
 */
export function googleMapsEmbedUrl(place: { lat: number; lng: number } | undefined): string {
  const [query, zoom] = place ? [`${place.lat},${place.lng}`, EMBED_ZOOM] : [encodeURIComponent("Tepa, Ghana"), EMBED_TOWN_ZOOM];
  return `https://maps.google.com/maps?q=${query}&t=k&z=${zoom}&hl=en&output=embed`;
}

/**
 * How far to pan the map, in pixels, to bring an open popup inside the frame, keeping each side's
 * margin clear (more at the top, where the map's controls sit). Positive x moves the view east
 * (the popup goes left), positive y south (the popup goes up), as Google's panBy takes them. A
 * popup bigger than the room left keeps its top left corner in view.
 */
export function panToShow(popup: ScreenBox, frame: ScreenBox, margin: ScreenBox): { x: number; y: number } {
  const offset = (start: number, end: number, roomStart: number, roomEnd: number) => {
    if (start < roomStart) return start - roomStart;
    if (end > roomEnd) return end - roomEnd;
    return 0;
  };
  return {
    x: offset(popup.left, popup.right, frame.left + margin.left, frame.right - margin.right),
    y: offset(popup.top, popup.bottom, frame.top + margin.top, frame.bottom - margin.bottom),
  };
}

/** The closest zoom Google says it has imagery for, or the safe default when it gives no usable answer. */
export function usableMaxZoom(zoom: number | null | undefined): number {
  return typeof zoom === "number" && Number.isInteger(zoom) && zoom > 0 ? zoom : DEFAULT_MAX_ZOOM;
}
