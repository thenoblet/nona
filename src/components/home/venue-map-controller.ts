import type { GoogleMapsLibraries } from "./google-maps";

/** Waiting for Google's map, drawn, or given up on for good. */
export type VenueMapStatus = "waiting" | "ready" | "failed";

/** How long a drawn map has for its first tiles before the frame falls back to the keyless embed. */
export const TILES_TIMEOUT_MILLISECONDS = 10_000;

/** A drawn map, changed in place or taken down. */
export type DrawnMap = { setPreview: (preview: boolean) => void; takeDown: () => void };

/** What the controller needs from Google and the page. The tests give it stand-ins. */
export type VenueMapServices = {
  /** Google's script and libraries (10 seconds at most). */
  load: () => Promise<GoogleMapsLibraries>;
  /** The closest zoom Google has imagery for at the places' first pin. */
  maxZoom: (libraries: GoogleMapsLibraries, placesKey: string) => Promise<number>;
  draw: (drawing: {
    libraries: GoogleMapsLibraries;
    placesKey: string;
    maxZoom: number;
    preview: boolean;
    onReady: () => void;
  }) => DrawnMap;
  /** Whether Google has already refused the key on this page. */
  keyRefused: () => boolean;
  /** Listens for Google refusing the key; returns the function that stops listening. */
  onKeyRefused: (listener: () => void) => () => void;
  onStatus: (status: VenueMapStatus) => void;
};

/**
 * One venue map's life, apart from React. Every map Google draws counts against the key's daily
 * cap, so the controller draws as few as it can:
 * - Once drawn, a map is kept. /home hidden and shown again (as Next keeps a visited page, and a
 *   client-side return shows it) reuses it, and a switch between phone and computer changes it
 *   in place. Only new places draw a new one.
 * - Nothing is drawn while the frame is hidden: a load that finishes then waits for the next show.
 * - A failure is final: the script failing or timing out, Google refusing the key (whenever it
 *   does, hidden or shown), or no first tiles within 10 seconds of drawing. The map is taken down,
 *   and nothing loads or draws again.
 */
export class VenueMapController {
  private readonly services: VenueMapServices;
  private status: VenueMapStatus = "waiting";
  private shown = false;
  private wanted: { placesKey: string; preview: boolean } | undefined;
  private drawing = false;
  /** Counts the maps drawn, so a late "ready" from a map since taken down is ignored. */
  private generation = 0;
  private drawn: { placesKey: string; map: DrawnMap; generation: number } | undefined;
  private tilesDeadline: ReturnType<typeof setTimeout> | undefined;
  private stopListening: (() => void) | undefined;

  constructor(services: VenueMapServices) {
    this.services = services;
  }

  /** The frame is near the screen, for these places, on a phone (preview) or a computer. */
  show(placesKey: string, preview: boolean): void {
    this.shown = true;
    this.wanted = { placesKey, preview };
    if (this.status === "failed") return;
    if (this.services.keyRefused()) {
      this.fail();
      return;
    }
    this.stopListening ??= this.services.onKeyRefused(() => this.fail());
    if (this.drawn?.placesKey === placesKey) {
      this.drawn.map.setPreview(preview);
      if (this.status === "waiting") this.startTilesDeadline();
      return;
    }
    void this.drawWanted();
  }

  /** The frame has gone (hidden with its page, or removed). The map is kept for the next show. */
  hide(): void {
    this.shown = false;
    this.stopListening?.();
    this.stopListening = undefined;
    this.stopTilesDeadline();
  }

  private async drawWanted(): Promise<void> {
    if (this.drawing) return;
    this.drawing = true;
    try {
      const libraries = await this.services.load();
      if (!this.stillWanted()) return;
      const maxZoom = await this.services.maxZoom(libraries, this.wanted?.placesKey ?? "");
      // Google may have refused the key, or the frame gone or changed, while it answered.
      const wanted = this.wanted;
      if (!this.stillWanted() || !wanted) return;
      this.takeDownDrawn();
      this.generation += 1;
      const generation = this.generation;
      const map = this.services.draw({
        libraries,
        placesKey: wanted.placesKey,
        maxZoom,
        preview: wanted.preview,
        onReady: () => {
          if (this.drawn?.generation === generation) this.ready();
        },
      });
      this.drawn = { placesKey: wanted.placesKey, map, generation };
      this.startTilesDeadline();
    } catch {
      this.fail();
    } finally {
      this.drawing = false;
    }
  }

  /** Still worth drawing: not failed, shown, and not already drawn for the places wanted. */
  private stillWanted(): boolean {
    return this.status !== "failed" && this.shown && this.drawn?.placesKey !== this.wanted?.placesKey;
  }

  private ready(): void {
    this.stopTilesDeadline();
    if (this.status === "failed") return;
    this.setStatus("ready");
  }

  private fail(): void {
    if (this.status === "failed") return;
    this.takeDownDrawn();
    this.stopListening?.();
    this.stopListening = undefined;
    this.setStatus("failed");
  }

  private startTilesDeadline(): void {
    this.stopTilesDeadline();
    this.tilesDeadline = setTimeout(() => this.fail(), TILES_TIMEOUT_MILLISECONDS);
  }

  private stopTilesDeadline(): void {
    clearTimeout(this.tilesDeadline);
    this.tilesDeadline = undefined;
  }

  private takeDownDrawn(): void {
    this.stopTilesDeadline();
    this.drawn?.map.takeDown();
    this.drawn = undefined;
  }

  private setStatus(status: VenueMapStatus): void {
    this.status = status;
    this.services.onStatus(status);
  }
}
