import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { getBoss, JOB_QUEUE_SCHEMA } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { errorMessage } from "@/lib/log-error";
import { workerConfig, type WorkerConfig } from "./config";
import { photoHandler } from "./jobs/photo";
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

/**
 * Each queue's handler: media.photo, a photo's thumbnail, viewing size and ThumbHash. A queue with
 * none yet keeps its jobs waiting, unfailed (Ruling AA), until the release that brings its handler:
 * - media.poster: Task 10, a video's probe and poster;
 * - media.convert: Task 11, a version every phone can play;
 * - media.visibility: Task 12, deleting and purging a hidden item's derived files;
 * - media.jpeg: Task 15, a HEIC's full-size JPEG, on its first download;
 * - media.wish: Task 16, a voice or video wish's recording;
 * - media.card: Task 19, a site photo's link-preview card.
 */
const handlers: MediaHandlers = {
  [MEDIA_QUEUES.photo]: photoHandler({ heifMemoryBytes: config.heifMemoryBytes, heifThreads: config.threads.heif }),
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
