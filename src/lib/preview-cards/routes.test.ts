import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Next's own naming of a metadata file's route, which the server uses to serve it.
import { fillStaticMetadataSegment } from "next/dist/lib/metadata/get-metadata-route";
import { describe, expect, it } from "vitest";
import { BUILT_IN_CARD_PATHS } from "./routes";

const appFolder = fileURLToPath(new URL("../../app/", import.meta.url));

describe("the built-in cards' routes", () => {
  it.each([
    ["invitation", "/", ""],
    ["rsvp", "/(site)/rsvp", "(site)/rsvp/"],
    ["album", "/(site)/album", "(site)/album/"],
    ["wishes", "/(site)/wishes", "(site)/wishes/"],
  ] as const)("names the %s card's route as Next serves it", (card, segment, folder) => {
    expect(existsSync(`${appFolder}${folder}opengraph-image.tsx`)).toBe(true);
    expect(BUILT_IN_CARD_PATHS[card]).toBe(fillStaticMetadataSegment(segment, "opengraph-image"));
  });
});

describe("the built-in cards stay static (Ruling CJ: the web server never draws a card)", () => {
  it.each([
    ["invitation", ""],
    ["rsvp", "(site)/rsvp/"],
    ["album", "(site)/album/"],
    ["wishes", "(site)/wishes/"],
  ] as const)("the %s card's route reads nothing at request time, so the build draws it once", (_card, folder) => {
    const source = readFileSync(`${appFolder}${folder}opengraph-image.tsx`, "utf8");
    // Any of these would make the route draw on a request (ƒ in the build table) instead of at build (○).
    for (const requestTime of [
      /\bconnection\s*\(/,
      /\bheaders\s*\(/,
      /\bcookies\s*\(/,
      /\bdraftMode\s*\(/,
      /\bsearchParams\b/,
      /from "next\/server"/,
      /from "next\/headers"/,
      /from "@\/lib\/content\/get"/,
      /from "@\/lib\/site-images\/get"/,
      /export const (dynamic|revalidate)\b/,
    ]) {
      expect(source, String(requestTime)).not.toMatch(requestTime);
    }
    expect(source).toMatch(/export default function Image\(\)/);
  });
});
