import sharp from "sharp";
import { errorMessage } from "@/lib/log-error";
import { PLACEHOLDER_MAX_EDGE, placeholderOf, type Placeholder } from "@/lib/media/thumbhash";
import { PermanentJobError } from "../queues";

/*
 * The still images the album shows of an item, made by sharp from one picture: a photo, or a
 * video's poster frame. Each is WebP, which sharp writes with no EXIF and so no location:
 * - the viewing size, at most 1600 px on its long edge, quality 80;
 * - the thumbnail, 480 px on its long edge, quality 70;
 * - the ThumbHash and average colour, from a copy at most 100 px on its long edge.
 */

export const VIEW = { longEdge: 1600, quality: 80 };
export const THUMB = { longEdge: 480, quality: 70 };

/** A picture sharp can decode, and how. */
export type StillSource = {
  path: string;
  /** Its format's pixel limit. */
  maxPixels: number;
  /** Turn it by its EXIF orientation; false when its decoder already turned its pixels (HEIC, AVIF, a poster). */
  autoOrient: boolean;
  /** What it is, for a failure's message: a photo's format, or "poster". */
  kind: string;
};

/** What deriveStills makes: small enough to hold in memory once the scratch folder is gone. */
export type Stills = {
  view: Buffer;
  thumb: Buffer;
  /** The upright picture's size. */
  width: number;
  height: number;
  placeholder: Placeholder;
};

/** sharp on a guest's file: never past its format's pixel limit, and aborting on a decode error but not a mere warning. */
export function decoder(path: string, maxPixels: number) {
  // failOn "error", not sharp's default "warning": many phones' JPEGs raise a warning libjpeg
  // decodes through ("Invalid SOS parameters"), and those are real photos.
  return sharp(path, { limitInputPixels: maxPixels, failOn: "error" });
}

// sharp's (libvips') words when the worker, not the file, is short of something: memory, open
// files or disk. A crafted file can't make sharp ask for much: the pixel limit comes first.
const WORKER_TROUBLE =
  /out of memory|cannot allocate memory|bad_alloc|too many open files|no space left on device|\b(ENOMEM|EMFILE|ENFILE|ENOSPC)\b/i;

/**
 * What sharp failing on a guest's file means: past the pixel limit, `too-large`; short of memory,
 * files or disk, the worker's trouble, so the job tries again; anything else, the file doesn't
 * decode, `corrupt`. Exported for its test.
 */
export function sharpFailure(kind: string, error: unknown): Error {
  const message = errorMessage(error);
  if (/exceeds pixel limit/i.test(message)) {
    return new PermanentJobError("too-large", `The ${kind} has more pixels than the album takes`);
  }
  if (WORKER_TROUBLE.test(message)) {
    return new Error(`sharp ran short making the ${kind}: ${message}`, { cause: error });
  }
  return new PermanentJobError("corrupt", `The ${kind} doesn't decode: ${message}`);
}

/** Runs sharp's work on a guest's file, its failure told apart by sharpFailure. */
export async function decoding<TResult>(kind: string, work: () => Promise<TResult>): Promise<TResult> {
  try {
    return await work();
  } catch (error) {
    throw sharpFailure(kind, error);
  }
}

/**
 * The viewing size, the thumbnail and the placeholder, from one decode: the picture is decoded and
 * shrunk once, to at most 1600 px on its long edge (a JPEG decodes straight at a smaller scale),
 * and the rest come from that copy. Nothing is ever enlarged. One after another, so an item never
 * takes more than sharp's threads (WORKER_SHARP_THREADS).
 */
export async function deriveStills(source: StillSource): Promise<Stills> {
  const { header, pixels } = await decoding(source.kind, async () => {
    const header = await decoder(source.path, source.maxPixels).metadata();
    const opened = decoder(source.path, source.maxPixels);
    const shrinking = source.autoOrient ? opened.autoOrient() : opened;
    const pixels = await shrinking
      .resize(VIEW.longEdge, VIEW.longEdge, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { header, pixels };
  });
  const upright = source.autoOrient ? header.autoOrient : { width: header.width, height: header.height };
  const fromView = () =>
    sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels } });
  const view = await fromView().webp({ quality: VIEW.quality }).toBuffer();
  const thumb = await fromView()
    .resize(THUMB.longEdge, THUMB.longEdge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: THUMB.quality })
    .toBuffer();
  const small = await fromView()
    .resize(PLACEHOLDER_MAX_EDGE, PLACEHOLDER_MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    view,
    thumb,
    width: upright.width,
    height: upright.height,
    placeholder: placeholderOf(small.info.width, small.info.height, small.data),
  };
}
