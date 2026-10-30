import { FILENAME_MAX_CHARACTERS, NAME_MAX_CHARACTERS } from "@/lib/db/schema";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The text cut to at most `maxCharacters` characters, counted as Postgres's char_length counts
 * them (code points, so an emoji is one), without splitting what a reader sees as one character:
 * a skin-toned emoji or an accented letter is kept whole or left out.
 */
export function clampCharacters(text: string, maxCharacters: number): string {
  if ([...text].length <= maxCharacters) return text;
  let kept = "";
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    const size = [...segment].length;
    if (count + size > maxCharacters) break;
    kept += segment;
    count += size;
  }
  return kept;
}

// C0 and C1 control characters: Postgres refuses NUL in text, and none of them can be shown.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The text as valid Unicode (a lone surrogate becomes U+FFFD) without control characters. */
function printable(text: string): string {
  return text.toWellFormed().replace(CONTROL_CHARACTERS, "");
}

/**
 * A guest's name as kept: printable, trimmed and cut to 80 characters, as it shows on every album
 * tile and in emails; an empty one (or one whose first character alone is too long) is kept as none.
 */
export function cleanName(name: string | null | undefined): string | null {
  const trimmed = printable(name ?? "").trim();
  if (!trimmed) return null;
  return clampCharacters(trimmed, NAME_MAX_CHARACTERS).trimEnd() || null;
}

/**
 * An original's filename as kept: its last path segment (a browser may send a whole path), printable,
 * trimmed and cut to 255 characters. It may be empty.
 */
export function cleanFilename(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  return clampCharacters(printable(basename).trim(), FILENAME_MAX_CHARACTERS).trimEnd();
}
