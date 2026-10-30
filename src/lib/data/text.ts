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
