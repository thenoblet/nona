import { fileURLToPath } from "node:url";
import { getBoss, JOB_QUEUE_SCHEMA } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { errorMessage } from "@/lib/log-error";
import { workerConfig, type WorkerConfig } from "./config";
import { notImplementedYet, type MediaHandlers } from "./queues";
import { runWorker } from "./runtime";

/*
 * The media worker: its own process and image (Dockerfile.worker, run as dist/worker/main.mjs),
 * on its own box, taking the media jobs the web app queues. scripts/build-worker.mjs bundles this
 * file; the bundle may reach nothing from next/.
 */

/** Each queue's handler. The later tasks replace these placeholders, which fail the job for good. */
const handlers: MediaHandlers = {
  // Task 9: a photo's thumbnail, viewing size and ThumbHash.
  [MEDIA_QUEUES.photo]: notImplementedYet,
  // Task 10: a video's probe and poster.
  [MEDIA_QUEUES.poster]: notImplementedYet,
  // Task 11: a version every phone can play.
  [MEDIA_QUEUES.convert]: notImplementedYet,
  // Task 12: deleting and purging a hidden item's derived files.
  [MEDIA_QUEUES.visibility]: notImplementedYet,
  // Task 15: a HEIC's full-size JPEG, on its first download.
  [MEDIA_QUEUES.jpeg]: notImplementedYet,
  // Task 16: a voice or video wish's recording.
  [MEDIA_QUEUES.wish]: notImplementedYet,
  // Task 19: a site photo's link-preview card.
  [MEDIA_QUEUES.card]: notImplementedYet,
};

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
