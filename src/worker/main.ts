import { fileURLToPath } from "node:url";
import { getBoss, JOB_QUEUE_SCHEMA } from "@/lib/jobs/boss";
import { errorMessage } from "@/lib/log-error";
import { workerConfig, type WorkerConfig } from "./config";
import type { MediaHandlers } from "./queues";
import { runWorker } from "./runtime";

/*
 * The media worker: its own process and image (Dockerfile.worker, run as dist/worker/main.mjs),
 * on its own box, taking the media jobs the web app queues. scripts/build-worker.mjs bundles this
 * file; the bundle may reach nothing from next/.
 */

/**
 * Each queue's handler. None has shipped yet, so every queue's jobs wait in it, unfailed (Ruling
 * AA), until the release that brings its handler:
 * - media.photo: Task 9, a photo's thumbnail, viewing size and ThumbHash;
 * - media.poster: Task 10, a video's probe and poster;
 * - media.convert: Task 11, a version every phone can play;
 * - media.visibility: Task 12, deleting and purging a hidden item's derived files;
 * - media.jpeg: Task 15, a HEIC's full-size JPEG, on its first download;
 * - media.wish: Task 16, a voice or video wish's recording;
 * - media.card: Task 19, a site photo's link-preview card.
 */
const handlers: MediaHandlers = {};

let config: WorkerConfig;
try {
  config = workerConfig();
} catch (error) {
  console.error("[worker] could not start:", errorMessage(error));
  process.exit(1);
}

await runWorker({
  config,
  handlers,
  migrationsFolder: fileURLToPath(new URL("./drizzle", import.meta.url)),
  startQueue: () => getBoss(config.queuePoolSize),
  queueSchema: JOB_QUEUE_SCHEMA,
});
