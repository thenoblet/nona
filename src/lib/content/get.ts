import "server-only";
import { cacheLife, cacheTag } from "next/cache";
import { contentOrDefaults, readSiteContent } from "./store";
import type { SiteContent } from "./schema";

export const CONTENT_TAG = "site-content";

/** Throws if the database read fails, so a failure is never cached. */
async function cachedRead(): Promise<SiteContent> {
  "use cache";
  cacheTag(CONTENT_TAG);
  cacheLife("max");
  return readSiteContent();
}

/** The site text: saved edits over the built-in defaults, cached until a save invalidates the tag. */
export async function getSiteContent(): Promise<SiteContent> {
  return contentOrDefaults(cachedRead);
}
