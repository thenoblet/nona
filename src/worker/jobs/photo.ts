import { createHash } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp, { type Metadata } from "sharp";
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
import { PermanentJobError, type JobReport, type MediaJob } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { PHOTO_TYPE_HEAD_BYTES, photoTypeOf, type PhotoFormat } from "./photo-type";

/*
 * media.photo: an uploaded photo becomes what the album shows. In its job's scratch folder:
 * 1. The original is streamed down, and its first bytes must be a photo format the album takes.
 * 2. It is decoded once, upright: a HEIC by heif-dec (to a JPEG at quality 95, its pixels already
 *    turned, so never turned again), anything else by sharp, turned by its EXIF orientation.
 * 3. From one copy at most 1600 px on its long edge come the viewing size, the thumbnail (480 px)
 *    and the 100 px copy the ThumbHash and average colour are made from. Each is WebP, which sharp
 *    writes with no EXIF and so no location.
 * 4. The capture time comes from the EXIF (capture-time.ts).
 * Then the two files go to the public bucket under a content hash, and the item turns `ready`,
 * listed, in the celebration its capture time falls in (unless the couple moved it), and its
 * manifest is written again. A HEIC's full-size JPEG is made later, on its first download (media.jpeg).
 *
 * A file that isn't a photo, or doesn't decode, fails for good: `unsupported-type` or `corrupt`,
 * or `too-large` past 100 megapixels. A job for an item that is no longer `uploaded`, or that
 * someone hid or deleted, does nothing (Ruling AG).
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
/** heif-dec takes about a second for a 12 MP photo. */
const HEIC_DECODE_MILLISECONDS = 60_000;
/** Scratch room beyond the original: a HEIC's decoded JPEG, which at 100 MP and quality 95 stays under this. */
const DECODED_JPEG_BYTES = 400 * 1024 * 1024;

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

/**
 * Decodes a HEIC with heif-dec into a JPEG beside it, upright. heif-dec writes one JPEG per image
 * in the file, numbered when there are several; the one wanted is the primary image's, which sharp
 * reported (`pagePrimary`) in the same order heif-dec numbers them.
 */
async function decodeHeic(original: string, header: Metadata, folder: string, signal: AbortSignal): Promise<string> {
  const output = join(folder, "decoded.jpg");
  try {
    await runProcess("heif-dec", ["--quiet", "--quality", String(HEIC_JPEG_QUALITY), original, output], {
      signal,
      timeoutMilliseconds: HEIC_DECODE_MILLISECONDS,
      // A photo's decode, which a guest is waiting for: never behind a conversion.
      priority: "foreground",
      cwd: folder,
    });
  } catch (error) {
    // It ran and refused the file. Killed (a timeout, the job's end, a stop) or unable to start, the job retries.
    if (error instanceof ProcessError && error.ending === "exit") {
      throw new PermanentJobError("corrupt", `The HEIC doesn't decode: ${error.message}`);
    }
    throw error;
  }
  const written = new Set(await readdir(folder));
  if (written.has("decoded.jpg")) return output;
  const primary = `decoded-${(header.pagePrimary ?? 0) + 1}.jpg`;
  if (written.has(primary)) return join(folder, primary);
  throw new PermanentJobError("corrupt", "heif-dec decoded no primary image from the HEIC");
}

/** The file to make the derived files from: the original, or for a HEIC its decoded JPEG. */
async function decodable(original: string, format: PhotoFormat, folder: string, signal: AbortSignal): Promise<Decodable> {
  if (format !== "heif") return { path: original, autoOrient: true, kind: format };
  // The header only: its codec, its size (refused past 100 MP before anything decodes) and its primary image.
  const header = await decoding("HEIF", () => decoder(original).metadata());
  // libheif turns the pixels by the file's own rotation (irot) as it decodes, for heif-dec and sharp alike.
  if (header.compression === "av1") return { path: original, autoOrient: false, kind: "avif" };
  return { path: await decodeHeic(original, header, folder, signal), autoOrient: false, kind: "heic" };
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
async function deriveFromOriginal(originalKey: string, folder: string, signal: AbortSignal): Promise<Derived> {
  const original = join(folder, "original");
  await saveOriginal(originalKey, original, signal);
  const type = photoTypeOf(await readHead(original));
  if (!type.ok) throw new PermanentJobError(type.reason, `The original is ${type.found}, not a photo the album takes`);
  const source = await decodable(original, type.format, folder, signal);
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

/** media.photo's handler. Its job's data is `{ mediaId }`. */
export async function processPhoto(job: MediaJob): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const item = await findItemToProcess(mediaId);
  if (!item) {
    console.log(`[worker] media.photo job=${job.id}: nothing to do, the item is no longer uploaded, or hidden or deleted`);
    return;
  }
  const original = await headOriginal(item.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${item.originalKey} isn't in the private bucket`);

  const derived = await withScratch(original.size + DECODED_JPEG_BYTES, (folder) =>
    deriveFromOriginal(item.originalKey, folder, job.signal),
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
