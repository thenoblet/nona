import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Transform } from "node:stream";
import { findPhotoForJpeg, markFullSizeJpeg, type PhotoForJpeg } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { keepOnlyCaptureTime } from "./jpeg-metadata";
import { DECODED_JPEG_BYTES, decodeHeic, MAX_HEIF_PIXELS, readHead, type HeifContext, type PhotoOptions } from "./photo";
import { photoTypeOf } from "./photo-type";
import { contentHashOf, rewriteManifest, withdrawIfHidden } from "./publishing";
import { decoder, decoding } from "./stills";

/*
 * media.jpeg (Task 15): an iPhone photo's full-size JPEG, which opens on any phone, made on its first
 * "As JPEG" download (the download route sends the job; the guest's phone asks again until it is
 * there). A job:
 * 1. finds a ready, visible album HEIC with no JPEG yet (Ruling AG): anything else, a second delivery
 *    included, does nothing;
 * 2. streams the original into its scratch folder, and checks its first bytes are a HEIF still (an
 *    AVIF, or anything else, fails for good as `unsupported-type`);
 * 3. decodes it with heif-dec exactly as media.photo does (decodeHeic): its images listed and
 *    checked by heif-info first, both tools under WORKER_HEIF_MEMORY_BYTES (prlimit --as) and a
 *    minute's time, on WORKER_HEIF_THREADS, upright, at quality 95. A 210 MP photo takes about 6 s
 *    and makes about 100 MB;
 * 4. streams that JPEG to the public bucket through keepOnlyCaptureTime (no location: every metadata
 *    segment out, only when it was taken back in), under a content hash, cached for good, never
 *    held in memory;
 * 5. names it `derived.jpeg` while the photo is still ready, visible and in the same generation, and
 *    writes its manifest. A photo hidden (or unhidden into a new generation) while it worked
 *    publishes nothing: its JPEG comes down, recorded for media.visibility (withdrawIfHidden).
 * A JPEG that fails is never the photo's failure: it stays ready, and media.dead only logs it. Logs
 * carry ids and sizes only.
 */

/**
 * Part of every JPEG's key. Raise it whenever what this job makes changes, so the files made again
 * get new keys, which no cache has seen.
 */
const JPEG_SETTINGS_VERSION = 1;

/** What the job takes from the worker's settings: the photo job's own, for libheif. */
export type JpegOptions = Pick<PhotoOptions, "heifMemoryBytes" | "heifThreads" | "heifDecodeMilliseconds" | "jobQueue">;

/** Counts the bytes going by, for the job's log. */
function byteCounter(): Transform & { bytes: number } {
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      counter.bytes += chunk.length;
      done(null, chunk);
    },
  }) as Transform & { bytes: number };
  counter.bytes = 0;
  return counter;
}

type Made = { outputBytes: number; decodeMilliseconds: number; uploadMilliseconds: number };

/** Downloads, checks, decodes and uploads, in the job's scratch folder. */
async function makeIn(folder: string, job: MediaJob, photo: PhotoForJpeg, key: string, options: JpegOptions): Promise<Made> {
  const original = join(folder, "original");
  await saveOriginal(photo.originalKey, original, job.signal);
  const type = photoTypeOf(await readHead(original));
  if (!type.ok || type.format !== "heif") {
    throw new PermanentJobError("unsupported-type", `The original is ${type.ok ? `a ${type.format}` : type.found}, not a HEIC`);
  }
  // An AVIF in a HEIF's clothes: phones open those, and libheif's heif-dec isn't what decodes it.
  const header = await decoding("HEIF", () => decoder(original, MAX_HEIF_PIXELS).metadata());
  if (header.compression === "av1") throw new PermanentJobError("unsupported-type", "The original is an AVIF, not a HEIC");

  const decodeStartedAt = performance.now();
  const context: HeifContext = { ...options, folder, signal: job.signal };
  const decoded = await decodeHeic(original, context);
  const uploadStartedAt = performance.now();
  const counter = byteCounter();
  const source = createReadStream(decoded);
  try {
    await putPublicObject(key, source.pipe(keepOnlyCaptureTime(photo.capturedAt)).pipe(counter), "image/jpeg", { signal: job.signal });
  } finally {
    source.destroy();
  }
  return {
    outputBytes: counter.bytes,
    decodeMilliseconds: Math.round(uploadStartedAt - decodeStartedAt),
    uploadMilliseconds: Math.round(performance.now() - uploadStartedAt),
  };
}

/** media.jpeg's work for one job, whose data is `{ mediaId }`. */
export async function makeFullSizeJpeg(job: MediaJob, options: JpegOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const photo = await findPhotoForJpeg(mediaId);
  if (!photo) {
    console.log(`[worker] media.jpeg job=${job.id}: nothing to do, the photo has its JPEG, or isn't a ready, visible album HEIC`);
    return;
  }
  const original = await headOriginal(photo.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${photo.originalKey} isn't in the private bucket`);
  const contentHash = contentHashOf(original.etag, `jpeg-settings-${JPEG_SETTINGS_VERSION}`, photo.derivedGeneration);
  const key = derivedKey(mediaId, contentHash, "jpeg", "jpg");

  const made = await withScratch(original.size + DECODED_JPEG_BYTES, (folder) => makeIn(folder, job, photo, key, options));
  console.log(
    `[worker] media.jpeg job=${job.id} media=${mediaId}: decoded in ${made.decodeMilliseconds} ms, ` +
      `${made.outputBytes} bytes uploaded in ${made.uploadMilliseconds} ms`,
  );

  const manifest = await markFullSizeJpeg(mediaId, { key, derivedGeneration: photo.derivedGeneration });
  if (!manifest) {
    // Hidden, deleted, or unhidden into a new generation while it was made: the JPEG comes down.
    await withdrawIfHidden(job.queue, mediaId, [key], {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: photo.derivedGeneration,
    });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind: "photo/heic-jpeg" };
}

/** media.jpeg's handler, with the worker's settings. */
export function jpegHandler(options: JpegOptions): MediaJobHandler {
  return (job) => makeFullSizeJpeg(job, options);
}
