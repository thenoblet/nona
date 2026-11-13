import type { BrowserContext, Page } from "@playwright/test";

/**
 * Google's map addresses: the keyless embed (maps.google.com, which moves on to
 * www.google.com/maps) and the Maps JavaScript API.
 */
const GOOGLE_MAPS = /^https:\/\/(maps\.google\.com\/|www\.google\.com\/maps|maps\.googleapis\.com\/)/;

/**
 * Keeps a page off Google's network: the venue map's embed and script fail at once, as if
 * offline, so no test waits on Google or depends on what it sends back.
 */
export async function blockGoogleMaps(target: Page | BrowserContext): Promise<void> {
  await target.route(GOOGLE_MAPS, (route) => route.abort());
}
