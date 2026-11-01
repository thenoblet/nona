import { thumbHashToDataURL } from "thumbhash";

/*
 * A moment's blurred preview while its thumbnail loads: its ThumbHash, decoded on the phone into a
 * small PNG (the server sends only the raw hash, about 25 bytes, never a data URL). Each hash is
 * decoded once a page.
 */

const decoded = new Map<string, string | null>();

/** The preview's data URL, or null for a hash that doesn't decode. */
export function placeholderUrl(thumbhash: string): string | null {
  const known = decoded.get(thumbhash);
  if (known !== undefined) return known;
  let url: string | null = null;
  try {
    url = thumbHashToDataURL(Uint8Array.from(atob(thumbhash), (character) => character.charCodeAt(0)));
  } catch {
    url = null;
  }
  decoded.set(thumbhash, url);
  return url;
}
