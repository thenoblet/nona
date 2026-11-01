import { existsSync } from "node:fs";
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
