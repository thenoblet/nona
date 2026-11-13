import { withTimeout, type GoogleMapsLibraries } from "./google-maps";
import { DEFAULT_MAX_ZOOM, panToShow, pinHtml, popupHtml, usableMaxZoom, type MapPlace } from "./venue-map";

const MAX_ZOOM_TIMEOUT_MILLISECONDS = 5_000;
/** Room kept between an open popup and the frame's edges, in pixels: the top clears Map/Satellite. */
const POPUP_MARGIN = { top: 60, right: 12, bottom: 12, left: 12 };

/**
 * The closest zoom Google has imagery for at the place, from its MaxZoomService. The safe default
 * when the service fails or takes more than 5 seconds.
 */
export async function imageryMaxZoom({ maps }: GoogleMapsLibraries, place: MapPlace): Promise<number> {
  try {
    const answer = await withTimeout(
      new maps.MaxZoomService().getMaxZoomAtLatLng({ lat: place.lat, lng: place.lng }),
      MAX_ZOOM_TIMEOUT_MILLISECONDS,
      "Google's imagery zoom took too long",
    );
    return usableMaxZoom(answer.zoom);
  } catch {
    return DEFAULT_MAX_ZOOM;
  }
}

/**
 * A place's numbered pin and the popup it opens, drawn over the map as one overlay: our own
 * markup rather than Google's markers, so it needs no Map ID. The pin is a button; Escape closes
 * its popup and puts the focus back on it. OverlayView only exists once Google's library has
 * loaded, so the class is made from it then.
 */
function placeOverlayClass(maps: google.maps.MapsLibrary) {
  return class PlaceOverlay extends maps.OverlayView {
    readonly place: MapPlace;
    isOpen = false;
    private readonly element: HTMLDivElement;
    private readonly pin: HTMLButtonElement;
    private readonly popup: HTMLElement;

    constructor(place: MapPlace, onToggle: (overlay: PlaceOverlay) => void) {
      super();
      this.place = place;
      this.element = document.createElement("div");
      this.element.className = "nona-place";
      this.element.innerHTML = pinHtml(place) + popupHtml(place);
      const pin = this.element.querySelector<HTMLButtonElement>(".nona-pin");
      const popup = this.element.querySelector<HTMLElement>(".nona-pop");
      if (!pin || !popup) throw new Error("The pin's markup has no button or no popup");
      this.pin = pin;
      this.popup = popup;
      pin.addEventListener("click", () => onToggle(this));
      this.element.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !this.isOpen) return;
        this.setOpen(false);
        pin.focus();
      });
      // Taps, drags and the wheel on a pin or its popup stay with them, not the map underneath.
      maps.OverlayView.preventMapHitsAndGesturesFrom(this.element);
    }

    setOpen(open: boolean) {
      this.isOpen = open;
      this.popup.hidden = !open;
      this.pin.setAttribute("aria-expanded", String(open));
      // An open popup sits above the other pins.
      this.element.classList.toggle("nona-place--open", open);
    }

    popupBox(): DOMRect {
      return this.popup.getBoundingClientRect();
    }

    onAdd() {
      this.getPanes()?.overlayMouseTarget.append(this.element);
    }

    draw() {
      const point = this.getProjection()?.fromLatLngToDivPixel({ lat: this.place.lat, lng: this.place.lng });
      if (!point) return;
      this.element.style.left = `${point.x}px`;
      this.element.style.top = `${point.y}px`;
    }

    onRemove() {
      this.element.remove();
    }
  };
}

type PlaceOverlay = InstanceType<ReturnType<typeof placeOverlayClass>>;

/**
 * Draws the satellite map (with labels) of the places into `canvas`, with a pin for each, framed
 * so all of them show: interactive, or as a still preview on phones. `onReady` runs once its first
 * tiles are in. Returns the function that takes the map down.
 */
export function drawVenueMap({
  libraries: { maps, core },
  canvas,
  places,
  maxZoom,
  backgroundColor,
  preview,
  padding,
  onReady,
}: {
  libraries: GoogleMapsLibraries;
  canvas: HTMLElement;
  places: MapPlace[];
  /** The closest zoom Google has imagery for here. */
  maxZoom: number;
  /** Shown until the tiles are in. */
  backgroundColor: string;
  /** On a phone the map is only a picture under a link to Google Maps: no controls, no gestures. */
  preview: boolean;
  /** Room the opening view keeps around the places (see fitPadding). */
  padding: google.maps.Padding;
  onReady: () => void;
}): () => void {
  const interactive = !preview;
  const map = new maps.Map(canvas, {
    mapTypeId: maps.MapTypeId.HYBRID,
    mapTypeControl: interactive,
    // With satellite listed beside hybrid, Google names the button "Satellite" (with a Labels tick,
    // on by default) rather than "Hybrid".
    mapTypeControlOptions: {
      mapTypeIds: [maps.MapTypeId.ROADMAP, maps.MapTypeId.SATELLITE, maps.MapTypeId.HYBRID],
      position: core.ControlPosition.TOP_LEFT,
    },
    zoomControl: interactive,
    // Bottom left, above Google's logo: the landmarks note covers the bottom right, Google's usual
    // place for it, and popups open upwards, into the top of the map.
    zoomControlOptions: { position: core.ControlPosition.LEFT_BOTTOM },
    cameraControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    // The wheel scrolls the page; ctrl with the wheel, or a drag, moves the map. A preview takes
    // no gestures at all: a tap on it opens Google Maps instead.
    gestureHandling: interactive ? "cooperative" : "none",
    keyboardShortcuts: interactive,
    // Our pins only: Google's own places don't open their cards.
    clickableIcons: false,
    // The opening view comes no closer than the default; once it is drawn, guests can zoom in to
    // the imagery's limit.
    maxZoom: Math.min(maxZoom, DEFAULT_MAX_ZOOM),
    backgroundColor,
  });

  const bounds = new core.LatLngBounds();
  for (const place of places) bounds.extend({ lat: place.lat, lng: place.lng });
  map.fitBounds(bounds, padding);
  core.event.addListenerOnce(map, "idle", () => map.setOptions({ maxZoom }));
  core.event.addListenerOnce(map, "tilesloaded", onReady);

  const PlaceOverlay = placeOverlayClass(maps);
  const overlays: PlaceOverlay[] = places.map((place) => new PlaceOverlay(place, toggle));

  /** Opens the overlay's popup, closing any other and bringing it into view, or closes it. */
  function toggle(target: PlaceOverlay) {
    const opening = !target.isOpen;
    for (const overlay of overlays) overlay.setOpen(opening && overlay === target);
    if (!opening) return;
    const offset = panToShow(target.popupBox(), canvas.getBoundingClientRect(), POPUP_MARGIN);
    if (offset.x || offset.y) map.panBy(offset.x, offset.y);
  }

  for (const overlay of overlays) overlay.setMap(map);
  // A tap on the map itself closes an open popup.
  map.addListener("click", () => {
    for (const overlay of overlays) overlay.setOpen(false);
  });

  return () => {
    for (const overlay of overlays) overlay.setMap(null);
    core.event.clearInstanceListeners(map);
    canvas.replaceChildren();
  };
}
