import { wedding } from "@/content/wedding";
import type { Celebration, SiteContent } from "./schema";

/** Where a celebration is held, as guests see it. */
export type CelebrationPlace = {
  /** "BN 111 Katakyie St, Tepa". */
  place: string;
  /** "GhanaPost GPS · AX-0084-3317", or null while the venue's GPS is still to confirm. */
  gpsLine: string | null;
  directionsUrl: string;
};

/** Details still to confirm are written in square brackets, like "[AS-0000-0000]". */
const isPlaceholder = (text: string) => /\[.*\]/.test(text);

/**
 * A celebration's place, GhanaPost GPS line and directions link, all from the venue it names, so
 * the couple type each once (under Venues) and every page, email and calendar file agrees.
 */
export function celebrationPlace(celebration: Pick<Celebration, "venue">, venues: SiteContent["venues"]): CelebrationPlace {
  const venue = venues[celebration.venue];
  return {
    place: `${venue.name}, ${wedding.town}`,
    gpsLine: isPlaceholder(venue.gps) ? null : `GhanaPost GPS · ${venue.gps}`,
    directionsUrl: venue.mapsUrl,
  };
}
