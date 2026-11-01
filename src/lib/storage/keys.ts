import { mediaBaseUrl } from "@/lib/env";

/**
 * Object keys in the two buckets:
 * - private: `originals/<mediaId>.<ext>` (each upload exactly as sent, never overwritten) and
 *   `manifests/<mediaId>.json` (the facts that change, rewritten on every change);
 * - public: `derived/<mediaId>/<contentHash>/<variant>.<ext>`. A new content hash means a new key,
 *   so the files can be cached for good. Site photos are media rows too and use the same keys.
 */

/**
 * Every derived file the worker writes. A video's `video` is its H.264 conversion; its `playable`
 * is a clean copy of the original's own streams (Task 14b): no metadata but its capture time,
 * `moov` first. A site photo (Task 19) has two sizes more, by width: `medium` (960 px) and `large`
 * (2400 px); `card` is a link preview card the worker drew from one.
 */
export const DERIVED_VARIANTS = [
  "thumb",
  "view",
  "jpeg",
  "poster-thumb",
  "poster-view",
  "video",
  "playable",
  "audio",
  "card",
  "medium",
  "large",
] as const;

export type DerivedVariant = (typeof DERIVED_VARIANTS)[number];

// Letters, digits, - and _ only: no dot, slash or backslash, so a part can't climb out of its
// folder (..) or add one (/), and an empty part is refused.
const SAFE_PART = /^[A-Za-z0-9_-]+$/;
const SAFE_EXTENSION = /^[A-Za-z0-9]+$/;

function safePart(name: string, value: string, pattern: RegExp = SAFE_PART): string {
  if (!pattern.test(value)) {
    throw new Error(`Refusing ${JSON.stringify(value)} as a storage key's ${name}`);
  }
  return value;
}

export function originalKey(mediaId: string, extension: string): string {
  return `originals/${safePart("mediaId", mediaId)}.${safePart("extension", extension, SAFE_EXTENSION)}`;
}

export function derivedKey(
  mediaId: string,
  contentHash: string,
  variant: DerivedVariant,
  extension: string,
): string {
  if (!DERIVED_VARIANTS.includes(variant)) {
    throw new Error(`Refusing ${JSON.stringify(variant)} as a storage key's variant`);
  }
  return [
    "derived",
    safePart("mediaId", mediaId),
    safePart("contentHash", contentHash),
    `${variant}.${safePart("extension", extension, SAFE_EXTENSION)}`,
  ].join("/");
}

/** The folder holding every derived file of an item, whatever its content hash: `derived/<mediaId>/`. */
export function derivedFolder(mediaId: string): string {
  return `derived/${safePart("mediaId", mediaId)}/`;
}

export function manifestKey(mediaId: string): string {
  return `manifests/${safePart("mediaId", mediaId)}.json`;
}

// The shapes the builders above make, so an operation can refuse a key meant for elsewhere.
const ORIGINAL_KEY = /^originals\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;
const DERIVED_KEY = new RegExp(
  `^derived/[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/(${DERIVED_VARIANTS.join("|")})\\.[A-Za-z0-9]+$`,
);

/** Whether originalKey could have made the key. */
export function isOriginalKey(key: string): boolean {
  return ORIGINAL_KEY.test(key);
}

/** The key, if originalKey could have made it; throws otherwise. */
export function assertOriginalKey(key: string): string {
  if (!ORIGINAL_KEY.test(key)) throw new Error(`Refusing ${JSON.stringify(key)}: not an originals/ key`);
  return key;
}

/** The key, if derivedKey could have made it; throws otherwise. */
export function assertDerivedKey(key: string): string {
  if (!DERIVED_KEY.test(key)) throw new Error(`Refusing ${JSON.stringify(key)}: not a derived/ key`);
  return key;
}

/** The address anyone can load a public-bucket key from: MEDIA_BASE_URL plus the key. */
export function publicUrl(key: string, env: Record<string, string | undefined> = process.env): string {
  return `${mediaBaseUrl(env)}/${key}`;
}
