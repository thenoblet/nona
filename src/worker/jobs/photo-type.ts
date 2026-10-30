/*
 * What an original's bytes really are, by their first bytes (magic numbers): the worker's layer of
 * the type allowlist. The upload API took the file on its declared type and name; here only the
 * bytes count. An album photo must be one of the formats the API accepts for photos (JPEG, PNG,
 * GIF, WebP, and HEIC, HEIF or AVIF), and must then decode. Anything else fails for good: a known
 * format the album doesn't take (a video, a PDF, an SVG, a program…) as `unsupported-type`, and
 * bytes of no known format as `corrupt`.
 */

/** The photo formats the album takes. HEIC, HEIF and AVIF share one container, told apart when decoded. */
export type PhotoFormat = "jpeg" | "png" | "gif" | "webp" | "heif";

export type PhotoTypeCheck =
  | { ok: true; format: PhotoFormat }
  | {
      ok: false;
      reason: "unsupported-type" | "corrupt";
      /** What the bytes were, in words for the log, never the bytes themselves. */
      found: string;
    };

/** How many of a file's first bytes photoTypeOf looks at: room for an ISO media file's whole brand list. */
export const PHOTO_TYPE_HEAD_BYTES = 4096;

// The ISO media brands of HEIC, HEIF and AVIF stills (and their sequences, whose primary image decodes).
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "mif2", "msf1", "miaf", "avif", "avis"]);
// The first box of a QuickTime movie written without `ftyp`.
const QUICKTIME_BOXES = new Set(["moov", "mdat", "wide", "free", "skip", "pnot"]);

function startsWith(head: Uint8Array, bytes: readonly number[], at = 0): boolean {
  return head.length >= at + bytes.length && bytes.every((byte, index) => head[at + index] === byte);
}

function text(head: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...head.subarray(at, at + length));
}

/** An ISO media file's brands (its `ftyp` box: the major brand and the compatible ones), or null for another file. */
function isoBrands(head: Uint8Array): string[] | null {
  if (head.length < 16 || text(head, 4, 4) !== "ftyp") return null;
  const boxSize = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  const end = Math.min(head.length, Math.max(16, boxSize));
  const brands = [text(head, 8, 4)];
  for (let at = 16; at + 4 <= end; at += 4) brands.push(text(head, at, 4));
  return brands;
}

/** The first byte that isn't a UTF-8 byte-order mark or white space, as text. */
function firstCharacter(head: Uint8Array): string {
  let at = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (at < head.length && [0x09, 0x0a, 0x0d, 0x20].includes(head[at])) at += 1;
  return at < head.length ? String.fromCharCode(head[at]) : "";
}

/** A known format the album doesn't take, by name, or null. */
function otherFormat(head: Uint8Array): string | null {
  if (isoBrands(head)) return "a video or other ISO media file";
  if (head.length >= 8 && QUICKTIME_BOXES.has(text(head, 4, 4))) return "a QuickTime video";
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return "a Matroska or WebM file";
  if (text(head, 0, 4) === "RIFF") return "a RIFF file (AVI or WAV)";
  if (text(head, 0, 4) === "%PDF") return "a PDF";
  if (firstCharacter(head) === "<") return "markup (SVG, HTML or XML)";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return "a zip archive";
  if (text(head, 0, 2) === "MZ" || startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return "a program";
  if (text(head, 0, 4) === "II*\0" || text(head, 0, 4) === "MM\0*") return "a TIFF or camera raw";
  if (text(head, 0, 2) === "BM") return "a BMP";
  if (startsWith(head, [0xff, 0x0a]) || startsWith(head, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20])) return "a JPEG XL";
  if (["ID3", "OggS", "fLaC"].some((magic) => text(head, 0, magic.length) === magic)) return "a recording";
  return null;
}

/** What the file whose first bytes (up to PHOTO_TYPE_HEAD_BYTES of them) are `head` is, as a photo. */
export function photoTypeOf(head: Uint8Array): PhotoTypeCheck {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { ok: true, format: "jpeg" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, format: "png" };
  if (text(head, 0, 6) === "GIF87a" || text(head, 0, 6) === "GIF89a") return { ok: true, format: "gif" };
  if (text(head, 0, 4) === "RIFF" && text(head, 8, 4) === "WEBP") return { ok: true, format: "webp" };
  if (isoBrands(head)?.some((brand) => HEIF_BRANDS.has(brand))) return { ok: true, format: "heif" };
  const other = otherFormat(head);
  if (other) return { ok: false, reason: "unsupported-type", found: other };
  return { ok: false, reason: "corrupt", found: head.length === 0 ? "an empty file" : "bytes of no known format" };
}
