import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getBoss, JOB_QUEUE_SCHEMA } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { errorMessage } from "@/lib/log-error";
import { workerConfig, type WorkerConfig } from "./config";
import { cardHandler } from "./jobs/card";
import { convertHandler } from "./jobs/convert";
import { jpegHandler } from "./jobs/jpeg";
import { photoHandler } from "./jobs/photo";
import { playableHandler } from "./jobs/playable";
import { posterHandler } from "./jobs/poster";
import { visibilityHandler } from "./jobs/visibility";
import { wishHandler } from "./jobs/wish";
import type { MediaHandlers } from "./queues";
import { runWorker } from "./runtime";

/*
 * The media worker: its own process and image (Dockerfile.worker, run as dist/worker/main.mjs),
 * on its own box, taking the media jobs the web app queues. scripts/build-worker.mjs bundles this
 * file; the bundle may reach nothing from next/.
 */

let config: WorkerConfig;
try {
  config = workerConfig();
} catch (error) {
  console.error("[worker] could not start:", errorMessage(error));
  process.exit(1);
}

// The worker's own queue, which runWorker starts (with this pool size) before any job runs.
const jobQueue = () => getBoss(config.queuePoolSize);

/**
 * Each queue's handler: media.photo, a photo's thumbnail, viewing size and ThumbHash; media.jpeg, an
 * iPhone photo's full-size JPEG, on its first download; media.poster, a video's probe and poster;
 * media.playable, a clean copy of a video's own streams, which the album plays an H.264 video from;
 * media.convert, an H.264 version of a video every phone can play (on demand at once, the backlog
 * while its switch is on); media.wish, a voice or video wish's recording made into what the wishes
 * wall plays (Task 16); media.visibility, deleting a hidden item's public files and purging them
 * from Cloudflare (CF_PURGE_TOKEN and CF_ZONE_ID); and media.card, a link preview card drawn once the
 * couple change its photo (Task 19), with the fonts and built-in photos in the image beside this
 * file (card-assets/, which scripts/build-worker.mjs copies). A queue with no handler would keep its
 * jobs waiting, unfailed (Ruling AA), until the release that brings one.
 */
const handlers: MediaHandlers = {
  [MEDIA_QUEUES.photo]: photoHandler({ heifMemoryBytes: config.heifMemoryBytes, heifThreads: config.threads.heif, jobQueue }),
  [MEDIA_QUEUES.jpeg]: jpegHandler({ heifMemoryBytes: config.heifMemoryBytes, heifThreads: config.threads.heif, jobQueue }),
  [MEDIA_QUEUES.poster]: posterHandler({
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    posterThreads: config.threads.poster,
    filterThreads: config.threads.ffmpegFilters,
    jobQueue,
    convertMaxSeconds: config.convertMaxSeconds,
  }),
  [MEDIA_QUEUES.convert]: convertHandler({
    convertMemoryBytes: config.convertMemoryBytes,
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    decoderThreads: config.threads.decoder,
    x264Threads: config.threads.x264,
    filterThreads: config.threads.ffmpegFilters,
    cpus: config.cpus,
    x264Preset: config.x264Preset,
    x264Cap: config.x264Cap,
    convertMaxSeconds: config.convertMaxSeconds,
    jobQueue,
  }),
  [MEDIA_QUEUES.playable]: playableHandler({ ffmpegMemoryBytes: config.ffmpegMemoryBytes, jobQueue }),
  [MEDIA_QUEUES.wish]: wishHandler({
    convertMemoryBytes: config.convertMemoryBytes,
    ffmpegMemoryBytes: config.ffmpegMemoryBytes,
    decoderThreads: config.threads.decoder,
    x264Threads: config.threads.x264,
    filterThreads: config.threads.ffmpegFilters,
    x264Preset: config.x264Preset,
    convertMaxSeconds: config.convertMaxSeconds,
    jobQueue,
  }),
  [MEDIA_QUEUES.visibility]: visibilityHandler({}),
  [MEDIA_QUEUES.card]: cardHandler({
    fontsFolder: fileURLToPath(new URL("./card-assets/fonts", import.meta.url)),
    publicFolder: fileURLToPath(new URL("./card-assets/public", import.meta.url)),
  }),
};

// libvips' threads for each image, from WORKER_SHARP_THREADS, never the host's core count (Ruling
// R). No operation cache: every job's files are new, and a cached one would hold its scratch file open.
sharp.concurrency(config.threads.sharp);
sharp.cache(false);

await runWorker({
  config,
  handlers,
  migrationsFolder: fileURLToPath(new URL("./drizzle", import.meta.url)),
  startQueue: () => getBoss(config.queuePoolSize),
  queueSchema: JOB_QUEUE_SCHEMA,
});
