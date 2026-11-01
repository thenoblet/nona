import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readSection } from "@/lib/content/store";
import { assignCelebration } from "@/lib/media/celebration";
import { errorMessage } from "@/lib/log-error";
import { plausibleCaptureTime, readPhotoCaptureTime } from "@/lib/media/capture-time";
import { findItemToProcess, markPhotoReady } from "@/lib/media/rows";
import { derivedKey, type DerivedVariant } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import { ProcessError } from "../processes";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { describeEnding, killedFromOutside, runCapped, toolDidNotRun } from "./capped-tools";
import { PHOTO_TYPE_HEAD_BYTES, photoTypeOf, type PhotoFormat } from "./photo-type";
import { contentHashOf, rewriteManifest, withdrawIfHidden, type JobQueue } from "./publishing";
import { decoder, deriveSiteSizes, deriveStills, sharpFailure, type SiteSizes, type Stills, type StillSource } from "./stills";

/*
 * media.photo: an uploaded photo becomes what the album shows. In its job's scratch folder:
 * 1. The original is streamed down, and its first bytes must be a photo format the album takes.
 * 2. It is decoded once, upright: a HEIC by heif-dec (to a JPEG at quality 95, its pixels already
 *    turned, so never turned again), anything else by sharp, turned by its EXIF orientation. A
 *    HEIC's images are listed by heif-info and checked first, and both tools run under a memory
 *    cap (WORKER_HEIF_MEMORY_BYTES), since heif-dec decodes every image in the file.
 * 3. From one copy at most 1600 px on its long edge come the viewing size, the thumbnail (480 px)
 *    and the 100 px copy the ThumbHash and average colour are made from (stills.ts, which a video's
 *    poster shares). Each is WebP, which sharp writes with no EXIF and so no location.
 * 4. The capture time comes from the EXIF (capture-time.ts).
 * 5. A site photo (purpose "site", the couple's own from the admin, Task 19) gets two sizes more by
 *    width, 960 and 2400 px (Ruling CI), from a second decode at the larger; the album's stay as they are.
 * Then the files go to the public bucket under a content hash, and the item turns `ready`,
 * listed, in the celebration its capture time falls in (unless the couple moved it), and its
 * manifest is written again. A HEIC's full-size JPEG is made later, on its first download (media.jpeg).
 *
 * A file that isn't a photo, or doesn't decode, fails for good: `unsupported-type` or `corrupt`,
 * or `too-large` past its format's pixel limit (a HEIC's images all together). A HEIC with more
 * than 8 images is `unsupported-type`, and one heif-dec can't decode within its cap or time is
 * `corrupt`. The worker's own trouble (memory, files, disk, a program killed from outside) retries.
 * A job for an item that is no longer `uploaded`, or that someone hid or deleted, does nothing
 * (Ruling AG).
 */

/**
 * Part of every derived file's key. Raise it whenever what this job makes changes (a size, a
 * quality), so the files made again get new keys, which no cache has seen.
 */
const PHOTO_SETTINGS_VERSION = 1;
/**
 * The most pixels a JPEG may have: 210 MP, a Galaxy Ultra's 200 MP mode (16320 × 12240) and room
 * (Ruling AK). Measured with sharp 0.35.5 on one thread, decoding to the 1600 px copy: a baseline
 * JPEG decodes straight at an eighth of its size, so 108 MP and 200 MP ones peak at 81–86 MiB, turned
 * or not. The worst a JPEG this size can do is hold several scans (progressive, or a sequential one
 * with a scan per component), which libjpeg must keep whole at about 8 bytes a pixel with four
 * components: a crafted 209.7 MP file peaked at 1,687 MiB. So about 1.65 GiB a job and 3.3 GiB with
 * WORKER_PHOTO_CONCURRENCY's 2 at once, accepted inside the worker's 12 GB (Ruling AK).
 */
const MAX_JPEG_PIXELS = 210_000_000;
/**
 * The most pixels any other format may have (a 200 MP PNG peaks at about 200 MiB, but no phone
 * writes one): past this a "photo" is a threat to the worker's memory, not a guest's picture.
 */
const MAX_OTHER_PIXELS = 100_000_000;
/**
 * The most pixels a HEIC's top-level images may hold together, all of which heif-dec decodes: as
 * many as a JPEG, since a Galaxy Ultra saves its 200 MP shots as HEIF when "High efficiency
 * pictures" is on. Measured in the worker image on one thread: heif-dec decodes a 200 MP tiled HEIC
 * within 366 MiB of address space (a 48 MP one within 271 MiB), far inside WORKER_HEIF_MEMORY_BYTES's
 * 2 GiB, and writes a baseline JPEG that sharp then decodes at a 174 MiB peak (a detailed 200 MP one).
 */
export const MAX_HEIF_PIXELS = MAX_JPEG_PIXELS;
const HEIC_JPEG_QUALITY = 95;
/** heif-dec's time limit unless the options say otherwise: it takes about a second for a 12 MP photo. */
const HEIC_DECODE_MILLISECONDS = 60_000;
/** heif-info reads only the file's boxes. */
const HEIF_INFO_MILLISECONDS = 10_000;
/** The most top-level images a HEIF may hold. Phones write one; thumbnails and depth maps aren't top-level. */
const MAX_HEIF_IMAGES = 8;
/**
 * Scratch room beyond the original: a HEIC's decoded JPEG, which at 210 MP and quality 95 (3 bytes
 * a pixel at worst) stays under this.
 */
export const DECODED_JPEG_BYTES = 1024 * 1024 * 1024;

/** What the job takes from the worker's settings. */
export type PhotoOptions = {
  /** The memory (address space) heif-info and heif-dec may take: WORKER_HEIF_MEMORY_BYTES. */
  heifMemoryBytes: number;
  /** heif-dec's codec and tile threads: WORKER_HEIF_THREADS. */
  heifThreads: number;
  /** heif-dec's time limit; 60 s unless a test wants it shorter. */
  heifDecodeMilliseconds?: number;
  /** The job queue a withdrawal is sent to, for a photo hidden while it was processed. */
  jobQueue: JobQueue;
};

/** Where and how a job runs libheif's tools (media.jpeg's too). */
export type HeifContext = Pick<PhotoOptions, "heifMemoryBytes" | "heifThreads" | "heifDecodeMilliseconds"> & {
  folder: string;
  signal: AbortSignal;
};

/** One of a HEIF's top-level images, as heif-info lists it. */
export type HeifImage = { width: number; height: number; primary: boolean };

/** A file sharp can decode, and how; its kind, for the job's log, is the photo's real format. */
type Decodable = StillSource & { kind: PhotoFormat | "heic" | "avif" };

/** What the scratch folder's work made: small enough to hold in memory once the folder is gone. */
type Derived = Stills & {
  kind: Decodable["kind"];
  capturedAt: Date | null;
  /** A site photo's extra sizes; null for the album's. */
  site: SiteSizes | null;
};

/** The settings a site photo's files are made with, beside the album's: raise it when its sizes change. */
const SITE_SETTINGS_VERSION = 1;

/** The first bytes of a file, for its magic numbers. */
export async function readHead(path: string): Promise<Uint8Array> {
  const file = await open(path, "r");
  try {
    const { buffer, bytesRead } = await file.read(Buffer.alloc(PHOTO_TYPE_HEAD_BYTES), 0, PHOTO_TYPE_HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

// How a libheif tool ended when the file was to blame: it refused the file (or died on it), ran
// past its time, or printed far too much. Near its memory cap heif-dec may stop and wait forever
// rather than exit, so a timeout is the file's fault too: a real photo decodes in seconds.
const FILE_AT_FAULT = new Set(["exit", "timeout", "too-much-output"]);

/**
 * What heif-info or heif-dec failing means. The file's fault fails for good, as `corrupt`: the
 * tool refused it, died on it (SIGSEGV, SIGABRT: under prlimit --as a crafted file gets ENOMEM,
 * never a SIGKILL), ran past its time or printed far too much. Anything else is passed on and the
 * job tries again: a SIGKILL the worker didn't send (the kernel's OOM killer, when a conversion
 * beside it filled the container), the job ending, the worker stopping, or the tool unable to run.
 * Exported for its test.
 */
export function heifToolFailure(tool: "heif-info" | "heif-dec", error: unknown, memoryBytes: number): unknown {
  if (!(error instanceof ProcessError) || !FILE_AT_FAULT.has(error.ending)) return error;
  if (toolDidNotRun(error) || killedFromOutside(error)) return error;
  const lastLine = error.stderrTail.trim().split("\n").at(-1) ?? "";
  return new PermanentJobError(
    "corrupt",
    `${tool} couldn't read the HEIC, under a ${memoryBytes}-byte cap: ${describeEnding(error)}: ${lastLine}`,
  );
}

/**
 * Runs heif-info or heif-dec under the memory cap (runCapped): a photo, which a guest is waiting
 * for, never waits behind a conversion. Returns its stdout. A failure is told apart by
 * heifToolFailure.
 */
async function runHeifTool(
  tool: "heif-info" | "heif-dec",
  args: string[],
  context: HeifContext,
  timeoutMilliseconds: number,
): Promise<string> {
  try {
    const { stdout } = await runCapped(tool, args, {
      memoryBytes: context.heifMemoryBytes,
      signal: context.signal,
      timeoutMilliseconds,
      priority: "foreground",
      cwd: context.folder,
    });
    return stdout;
  } catch (error) {
    throw heifToolFailure(tool, error, context.heifMemoryBytes);
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
 * could hide a huge one behind a small primary: all of them together must stay within the pixels
 * one photo may have, and there may be no more than 8. heif-info reads only the file's boxes,
 * under the same cap.
 */
async function heifImages(original: string, context: HeifContext): Promise<HeifImage[]> {
  const images = heifImagesIn(await runHeifTool("heif-info", [original], context, HEIF_INFO_MILLISECONDS));
  if (!images) throw new PermanentJobError("corrupt", "heif-info couldn't list the HEIC's images");
  if (images.length > MAX_HEIF_IMAGES) {
    throw new PermanentJobError("unsupported-type", `The HEIC holds ${images.length} images; a photo holds one`);
  }
  const pixels = images.reduce((total, image) => total + image.width * image.height, 0);
  if (pixels > MAX_HEIF_PIXELS) {
    throw new PermanentJobError(
      "too-large",
      `The HEIC's ${images.length} image(s) hold ${pixels} pixels, more than ${MAX_HEIF_PIXELS}`,
    );
  }
  return images;
}

/**
 * Decodes a HEIC with heif-dec into a JPEG beside it, upright. heif-dec (libheif 1.23) has no way
 * to decode the primary image alone: it writes one JPEG per top-level image, numbered in
 * heif-info's order when there are several, and the one wanted is the primary's. media.jpeg uses it
 * too, for a HEIC's full-size JPEG: the same checks, caps and failures.
 */
export async function decodeHeic(original: string, context: HeifContext): Promise<string> {
  const images = await heifImages(original, context);
  const output = join(context.folder, "decoded.jpg");
  // Its threads from WORKER_HEIF_THREADS, never libheif's own 4 tiles at once (Ruling R).
  const threads = String(context.heifThreads);
  const decodeArgs = ["--quiet", "--codec-threads", threads, "--tile-threads", threads];
  decodeArgs.push("--quality", String(HEIC_JPEG_QUALITY), original, output);
  await runHeifTool("heif-dec", decodeArgs, context, context.heifDecodeMilliseconds ?? HEIC_DECODE_MILLISECONDS);
  const primary = images.length === 1 ? "decoded.jpg" : `decoded-${images.findIndex((image) => image.primary) + 1}.jpg`;
  if ((await readdir(context.folder)).includes(primary)) return join(context.folder, primary);
  throw new PermanentJobError("corrupt", "heif-dec decoded no primary image from the HEIC");
}

// sharp's own (bundled) libheif refuses a HEIF whose index names more than 256 items, as a very large
// phone photo's does: a 200 MP one in 512 px tiles holds 768. The worker's heif-dec takes them.
const PAST_SHARPS_ITEM_LIMIT = /security limit exceeded: iloc box contains \d+ items/i;

/**
 * A HEIF's compression ("hevc", "av1"…), from its header alone, which also refuses a primary image
 * past the pixel limit before anything decodes. Ruling BN: null for a file whose index is past sharp's
 * own libheif's item limit; heif-info and heif-dec judge it then (its images, its pixels, whether it
 * decodes), so a damaged file still fails as `corrupt`. Any other refusal is sharpFailure's.
 */
export async function heifCompression(path: string): Promise<string | null> {
  try {
    return (await decoder(path, MAX_HEIF_PIXELS).metadata()).compression ?? null;
  } catch (error) {
    if (PAST_SHARPS_ITEM_LIMIT.test(errorMessage(error))) return null;
    throw sharpFailure("HEIF", error);
  }
}

/** The file to make the derived files from: the original, or for a HEIC its decoded JPEG. */
async function decodable(original: string, format: PhotoFormat, context: HeifContext): Promise<Decodable> {
  if (format !== "heif") {
    const maxPixels = format === "jpeg" ? MAX_JPEG_PIXELS : MAX_OTHER_PIXELS;
    return { path: original, maxPixels, autoOrient: true, kind: format };
  }
  const compression = await heifCompression(original);
  // libheif turns the pixels by the file's own rotation (irot) as it decodes, for heif-dec and sharp alike.
  // An AVIF gets no heif-info check (decided in Task 9's review): sharp decodes its primary image
  // alone, and limitInputPixels bounds that one, so nothing else in the file is ever decoded.
  if (compression === "av1") {
    return { path: original, maxPixels: MAX_OTHER_PIXELS, autoOrient: false, kind: "avif" };
  }
  // heif-dec writes a baseline JPEG, which sharp decodes at a fraction of its size like any other.
  const decoded = await decodeHeic(original, context);
  return { path: decoded, maxPixels: MAX_JPEG_PIXELS, autoOrient: false, kind: "heic" };
}

/** Everything the job makes from the original, in its scratch folder: a site photo's extra sizes too. */
async function deriveFromOriginal(originalKey: string, forSite: boolean, context: HeifContext): Promise<Derived> {
  const original = join(context.folder, "original");
  await saveOriginal(originalKey, original, context.signal);
  const type = photoTypeOf(await readHead(original));
  if (!type.ok) throw new PermanentJobError(type.reason, `The original is ${type.found}, not a photo the album takes`);
  const source = await decodable(original, type.format, context);
  // A HEIC's EXIF is read from its decoded JPEG, which heif-dec writes it into in the standard way.
  const capturedAt = await readPhotoCaptureTime(source.path);
  const stills = await deriveStills(source);
  const site = forSite ? await deriveSiteSizes(source) : null;
  return { ...stills, kind: source.kind, capturedAt, site };
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

  const forSite = item.purpose === "site";
  const derived = await withScratch(original.size + DECODED_JPEG_BYTES, (folder) =>
    deriveFromOriginal(item.originalKey, forSite, { ...options, folder, signal: job.signal }),
  );
  // A time from a reset or wrong clock counts as none: the file's, then the phone's, then the upload's.
  const capturedAt =
    plausibleCaptureTime(derived.capturedAt, item.startedAt) ?? plausibleCaptureTime(item.capturedAt, item.startedAt);
  const { value: celebrations } = await readSection("celebrations");
  const settings = `photo-settings-${PHOTO_SETTINGS_VERSION}${forSite ? `+site-${SITE_SETTINGS_VERSION}` : ""}`;
  const contentHash = contentHashOf(original.etag, settings, item.derivedGeneration);
  const files: [DerivedVariant, Buffer][] = [
    ["thumb", derived.thumb],
    ["view", derived.view],
    ...(derived.site ? ([["medium", derived.site.medium], ["large", derived.site.large]] as [DerivedVariant, Buffer][]) : []),
  ];
  const keys: Partial<Record<DerivedVariant, string>> = Object.fromEntries(
    files.map(([variant]) => [variant, derivedKey(mediaId, contentHash, variant, "webp")]),
  );
  await Promise.all(
    files.map(([variant, bytes]) => putPublicObject(keys[variant] as string, bytes, "image/webp", { signal: job.signal })),
  );

  const manifest = await markPhotoReady(mediaId, {
    derived: keys,
    derivedGeneration: item.derivedGeneration,
    width: derived.width,
    height: derived.height,
    thumbhash: derived.placeholder.thumbhash,
    averageColor: derived.placeholder.averageColor,
    capturedAt,
    celebration: assignCelebration(capturedAt, item.startedAt, celebrations),
  });
  if (!manifest) {
    await withdrawIfHidden(job.queue, mediaId, Object.values(keys) as string[], {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: item.derivedGeneration,
    });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind: `${forSite ? "site-photo" : "photo"}/${derived.kind}` };
}

/** media.photo's handler, with the worker's settings. */
export function photoHandler(options: PhotoOptions): MediaJobHandler {
  return (job) => processPhoto(job, options);
}
