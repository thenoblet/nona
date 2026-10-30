import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { readSection } from "@/lib/content/store";
import { describeError, errorMessage } from "@/lib/log-error";
import { assignCelebration } from "@/lib/media/celebration";
import { readPhotoCaptureTime } from "@/lib/media/capture-time";
import { findItemToProcess, isVisible, markPhotoReady } from "@/lib/media/rows";
import { PLACEHOLDER_MAX_EDGE, placeholderOf, type Placeholder } from "@/lib/media/thumbhash";
import { derivedKey } from "@/lib/storage/keys";
import { writeManifest } from "@/lib/storage/manifest";
import { deletePublicObjects, headOriginal, putPublicObject } from "@/lib/storage/objects";
import { ProcessError, runProcess } from "../processes";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { PHOTO_TYPE_HEAD_BYTES, photoTypeOf, type PhotoFormat } from "./photo-type";

/*
 * media.photo: an uploaded photo becomes what the album shows. In its job's scratch folder:
 * 1. The original is streamed down, and its first bytes must be a photo format the album takes.
 * 2. It is decoded once, upright: a HEIC by heif-dec (to a JPEG at quality 95, its pixels already
 *    turned, so never turned again), anything else by sharp, turned by its EXIF orientation. A
 *    HEIC's images are listed by heif-info and checked first, and both tools run under a memory
 *    cap (WORKER_HEIF_MEMORY_BYTES), since heif-dec decodes every image in the file.
 * 3. From one copy at most 1600 px on its long edge come the viewing size, the thumbnail (480 px)
 *    and the 100 px copy the ThumbHash and average colour are made from. Each is WebP, which sharp
 *    writes with no EXIF and so no location.
 * 4. The capture time comes from the EXIF (capture-time.ts).
 * Then the two files go to the public bucket under a content hash, and the item turns `ready`,
 * listed, in the celebration its capture time falls in (unless the couple moved it), and its
 * manifest is written again. A HEIC's full-size JPEG is made later, on its first download (media.jpeg).
 *
 * A file that isn't a photo, or doesn't decode, fails for good: `unsupported-type` or `corrupt`,
 * or `too-large` past 100 megapixels (a HEIC's images all together). A HEIC with more than 8
 * images is `unsupported-type`, and one heif-dec can't decode within its cap or time is `corrupt`.
 * A job for an item that is no longer `uploaded`, or that someone hid or deleted, does nothing
 * (Ruling AG).
 */

/**
 * Part of every derived file's key. Raise it whenever what this job makes changes (a size, a
 * quality), so the files made again get new keys, which no cache has seen.
 */
const PHOTO_SETTINGS_VERSION = 1;
/** Hex characters of the content hash kept in a key: 64 bits, beside the item's own id. */
const CONTENT_HASH_CHARACTERS = 16;
/** Past this many pixels a "photo" is a threat to the worker's memory, not a guest's picture. */
const MAX_INPUT_PIXELS = 100_000_000;
const VIEW = { longEdge: 1600, quality: 80 };
const THUMB = { longEdge: 480, quality: 70 };
const HEIC_JPEG_QUALITY = 95;
/** heif-dec takes about a second for a 12 MP photo, and about 4 s for a 48 MP one. */
const HEIC_DECODE_MILLISECONDS = 60_000;
/** heif-info reads only the file's boxes. */
const HEIF_INFO_MILLISECONDS = 10_000;
/** The most top-level images a HEIF may hold. Phones write one; thumbnails and depth maps aren't top-level. */
const MAX_HEIF_IMAGES = 8;
/** Scratch room beyond the original: a HEIC's decoded JPEG, which at 100 MP and quality 95 stays under this. */
const DECODED_JPEG_BYTES = 400 * 1024 * 1024;

/** What the job takes from the worker's settings. */
export type PhotoOptions = {
  /** The memory (address space) heif-info and heif-dec may take: WORKER_HEIF_MEMORY_BYTES. */
  heifMemoryBytes: number;
};

/** Where and how a job runs libheif's tools. */
type HeifContext = PhotoOptions & { folder: string; signal: AbortSignal };

/** One of a HEIF's top-level images, as heif-info lists it. */
export type HeifImage = { width: number; height: number; primary: boolean };

/** A file sharp can decode, and how. */
type Decodable = {
  path: string;
  /** Turn it by its EXIF orientation; false when its decoder already turned its pixels (HEIC, AVIF). */
  autoOrient: boolean;
  /** For the job's log: the photo's real format. */
  kind: PhotoFormat | "heic" | "avif";
};

/** What the scratch folder's work made: small enough to hold in memory once the folder is gone. */
type Derived = {
  kind: Decodable["kind"];
  view: Buffer;
  thumb: Buffer;
  /** The upright photo's size. */
  width: number;
  height: number;
  placeholder: Placeholder;
  capturedAt: Date | null;
};

/** The first bytes of a file, for its magic numbers. */
async function readHead(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(PHOTO_TYPE_HEAD_BYTES), 0, PHOTO_TYPE_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** sharp on a guest's file: never past 100 megapixels, and aborting on a decode error but not a mere warning. */
function decoder(path: string) {
  // failOn "error", not sharp's default "warning": many phones' JPEGs raise a warning libjpeg
  // decodes through ("Invalid SOS parameters"), and those are real photos.
  return sharp(path, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
}

/** Runs sharp's work on a guest's file; its failure is the file's, so it fails for good. */
async function decoding<TResult>(kind: string, work: () => Promise<TResult>): Promise<TResult> {
  try {
    return await work();
  } catch (error) {
    const message = errorMessage(error);
    if (/exceeds pixel limit/i.test(message)) {
      throw new PermanentJobError("too-large", `The ${kind} has more than ${MAX_INPUT_PIXELS} pixels`);
    }
    throw new PermanentJobError("corrupt", `The ${kind} doesn't decode: ${message}`);
  }
}

// How a libheif tool ended when the file was to blame: it refused the file (or died on it), ran
// past its time, or printed far too much. Near its memory cap heif-dec may stop and wait forever
// rather than exit, so a timeout is the file's fault too: a real photo decodes in seconds.
const FILE_AT_FAULT = new Set(["exit", "timeout", "too-much-output"]);
// prlimit's own exit codes when it can't run the tool at all: the worker's install, not the file.
const TOOL_NOT_RUN = new Set([126, 127]);

/**
 * Runs heif-info or heif-dec under the memory cap (prlimit --as), at the worker's own priority: a
 * photo, which a guest is waiting for, never waits behind a conversion. prlimit replaces itself
 * with the tool, so the job's signal and the time limit kill the tool itself. Returns its stdout.
 * A failure that is the file's fails for good, as `corrupt`; anything else (the job ending, the
 * worker stopping, a tool missing) is passed on, and the job retries.
 */
async function runHeifTool(
  tool: "heif-info" | "heif-dec",
  args: string[],
  context: HeifContext,
  timeoutMilliseconds: number,
): Promise<string> {
  try {
    const { stdout } = await runProcess("prlimit", [`--as=${context.heifMemoryBytes}`, "--", tool, ...args], {
      signal: context.signal,
      timeoutMilliseconds,
      priority: "foreground",
      cwd: context.folder,
    });
    return stdout;
  } catch (error) {
    if (!(error instanceof ProcessError) || !FILE_AT_FAULT.has(error.ending)) throw error;
    if (error.ending === "exit" && error.exitCode !== null && TOOL_NOT_RUN.has(error.exitCode)) throw error;
    const lastLine = error.stderrTail.trim().split("\n").at(-1) ?? "";
    const ending = error.ending === "exit" ? `it exited with ${error.exitCode ?? "a signal"}` : `it was killed (${error.ending})`;
    throw new PermanentJobError(
      "corrupt",
      `${tool} couldn't read the HEIC, under a ${context.heifMemoryBytes}-byte cap: ${ending}: ${lastLine}`,
    );
  }
}

// "image: 4032x3024 (id=49), primary": a top-level image. Its thumbnails and auxiliary images are
// indented under it.
const HEIF_IMAGE_LINE = /^image: (\d+)x(\d+) \(id=\d+\)(, primary)?$/;

/**
 * The top-level images in heif-info's listing, in the order heif-dec numbers its outputs (both
 * take libheif's own list). Null when the listing can't be read: no image, an image line of
 * another shape, or not exactly one primary. Exported for its test.
 */
export function heifImagesIn(listing: string): HeifImage[] | null {
  const images: HeifImage[] = [];
  for (const line of listing.split("\n")) {
    if (!line.startsWith("image:")) continue;
    const parts = HEIF_IMAGE_LINE.exec(line.trimEnd());
    if (!parts) return null;
    images.push({ width: Number(parts[1]), height: Number(parts[2]), primary: parts[3] !== undefined });
  }
  const primaries = images.filter((image) => image.primary).length;
  return images.length > 0 && primaries === 1 ? images : null;
}

/**
 * The HEIC's top-level images, checked before anything decodes them. sharp's header and pixel
 * limit see only the primary image, but heif-dec decodes every top-level image, so a crafted file
 * could hide a huge one behind a small primary: all of them together must stay within the 100
 * megapixels one photo may have, and there may be no more than 8. heif-info reads only the file's
 * boxes, under the same cap.
 */
async function heifImages(original: string, context: HeifContext): Promise<HeifImage[]> {
  const images = heifImagesIn(await runHeifTool("heif-info", [original], context, HEIF_INFO_MILLISECONDS));
  if (!images) throw new PermanentJobError("corrupt", "heif-info couldn't list the HEIC's images");
  if (images.length > MAX_HEIF_IMAGES) {
    throw new PermanentJobError("unsupported-type", `The HEIC holds ${images.length} images; a photo holds one`);
  }
  const pixels = images.reduce((total, image) => total + image.width * image.height, 0);
  if (pixels > MAX_INPUT_PIXELS) {
    throw new PermanentJobError(
      "too-large",
      `The HEIC's ${images.length} image(s) hold ${pixels} pixels, more than ${MAX_INPUT_PIXELS}`,
    );
  }
  return images;
}

/**
 * Decodes a HEIC with heif-dec into a JPEG beside it, upright. heif-dec (libheif 1.23) has no way
 * to decode the primary image alone: it writes one JPEG per top-level image, numbered in
 * heif-info's order when there are several, and the one wanted is the primary's.
 */
async function decodeHeic(original: string, context: HeifContext): Promise<string> {
  const images = await heifImages(original, context);
  const output = join(context.folder, "decoded.jpg");
  const decodeArgs = ["--quiet", "--quality", String(HEIC_JPEG_QUALITY), original, output];
  await runHeifTool("heif-dec", decodeArgs, context, HEIC_DECODE_MILLISECONDS);
  const primary = images.length === 1 ? "decoded.jpg" : `decoded-${images.findIndex((image) => image.primary) + 1}.jpg`;
  if ((await readdir(context.folder)).includes(primary)) return join(context.folder, primary);
  throw new PermanentJobError("corrupt", "heif-dec decoded no primary image from the HEIC");
}

/** The file to make the derived files from: the original, or for a HEIC its decoded JPEG. */
async function decodable(original: string, format: PhotoFormat, context: HeifContext): Promise<Decodable> {
  if (format !== "heif") return { path: original, autoOrient: true, kind: format };
  // The header only: its codec, and the primary image's size (refused past 100 MP before anything
  // decodes). sharp decodes an AVIF's primary image alone, so its pixel limit covers all it decodes.
  const header = await decoding("HEIF", () => decoder(original).metadata());
  // libheif turns the pixels by the file's own rotation (irot) as it decodes, for heif-dec and sharp alike.
  if (header.compression === "av1") return { path: original, autoOrient: false, kind: "avif" };
  return { path: await decodeHeic(original, context), autoOrient: false, kind: "heic" };
}

/**
 * The viewing size, the thumbnail and the placeholder, from one decode: the photo is decoded and
 * shrunk once, to at most 1600 px on its long edge (a JPEG decodes straight at a smaller scale),
 * and the rest come from that copy. Nothing is ever enlarged.
 */
async function derive(source: Decodable): Promise<Omit<Derived, "capturedAt">> {
  const { header, pixels } = await decoding(source.kind, async () => {
    const header = await decoder(source.path).metadata();
    const shrinking = source.autoOrient ? decoder(source.path).autoOrient() : decoder(source.path);
    const pixels = await shrinking
      .resize(VIEW.longEdge, VIEW.longEdge, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { header, pixels };
  });
  const upright = source.autoOrient ? header.autoOrient : { width: header.width, height: header.height };
  const fromView = () =>
    sharp(pixels.data, { raw: { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels } });
  // One after another: each runs on WORKER_SHARP_THREADS threads, so a photo never takes more.
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
    kind: source.kind,
    view,
    thumb,
    width: upright.width,
    height: upright.height,
    placeholder: placeholderOf(small.info.width, small.info.height, small.data),
  };
}

/** Everything the job makes from the original, in its scratch folder. */
async function deriveFromOriginal(originalKey: string, context: HeifContext): Promise<Derived> {
  const original = join(context.folder, "original");
  await saveOriginal(originalKey, original, context.signal);
  const type = photoTypeOf(await readHead(original));
  if (!type.ok) throw new PermanentJobError(type.reason, `The original is ${type.found}, not a photo the album takes`);
  const source = await decodable(original, type.format, context);
  // A HEIC's EXIF is read from its decoded JPEG, which heif-dec writes it into in the standard way.
  const capturedAt = await readPhotoCaptureTime(source.path);
  return { ...(await derive(source)), capturedAt };
}

/** The derived files' content hash: the original's ETag (its bytes never change) and these settings. */
function contentHashOf(etag: string): string {
  return createHash("sha256")
    .update(`${etag}\nphoto-settings-${PHOTO_SETTINGS_VERSION}`)
    .digest("hex")
    .slice(0, CONTENT_HASH_CHARACTERS);
}

/**
 * After a ready mark that changed nothing: an item hidden, deleted or gone while the job worked
 * must have no public files, so the ones it put up come down. A visible item was finished by
 * another delivery, under these same keys, so they stay.
 */
async function withdrawIfHidden(mediaId: string, keys: string[], signal: AbortSignal): Promise<void> {
  if (await isVisible(mediaId)) return;
  try {
    await deletePublicObjects(keys, { signal });
    console.log(`[worker] media.photo media=${mediaId} was hidden while it was processed: its files were removed`);
  } catch (error) {
    console.error(
      `[worker] media.photo media=${mediaId} was hidden while it was processed, and its files could not be removed (${keys.join(", ")}):`,
      describeError(error),
    );
  }
}

/** media.photo's work for one job, whose data is `{ mediaId }`. */
export async function processPhoto(job: MediaJob, options: PhotoOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const item = await findItemToProcess(mediaId);
  if (!item) {
    console.log(`[worker] media.photo job=${job.id}: nothing to do, the item is no longer uploaded, or hidden or deleted`);
    return;
  }
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);

  const derived = await withScratch(original.size + DECODED_JPEG_BYTES, (folder) =>
    deriveFromOriginal(item.originalKey, { ...options, folder, signal: job.signal }),
  );
  const capturedAt = derived.capturedAt ?? item.capturedAt;
  const { value: celebrations } = await readSection("celebrations");
  const contentHash = contentHashOf(original.etag);
  const keys = {
    thumb: derivedKey(mediaId, contentHash, "thumb", "webp"),
    view: derivedKey(mediaId, contentHash, "view", "webp"),
  };
  await Promise.all([
    putPublicObject(keys.thumb, derived.thumb, "image/webp", { signal: job.signal }),
    putPublicObject(keys.view, derived.view, "image/webp", { signal: job.signal }),
  ]);

  const manifest = await markPhotoReady(mediaId, {
    derived: keys,
    width: derived.width,
    height: derived.height,
    thumbhash: derived.placeholder.thumbhash,
    averageColor: derived.placeholder.averageColor,
    capturedAt,
    celebration: assignCelebration(capturedAt, item.startedAt, celebrations),
  });
  if (!manifest) {
    await withdrawIfHidden(mediaId, [keys.thumb, keys.view], job.signal);
    return;
  }
  try {
    await writeManifest(mediaId, manifest, { signal: job.signal });
  } catch (error) {
    // The row is right, and the album shows it. Only a rebuild from R2 would read this manifest,
    // and a retry would find the item ready and do nothing, so it is said here instead.
    console.error(`[worker] media.photo media=${mediaId} is ready, but its manifest wasn't written:`, describeError(error));
  }
  return { sizeBytes: original.size, kind: `photo/${derived.kind}` };
}

/** media.photo's handler, with the worker's settings. */
export function photoHandler(options: PhotoOptions): MediaJobHandler {
  return (job) => processPhoto(job, options);
}
