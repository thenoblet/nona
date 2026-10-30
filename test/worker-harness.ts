/**
 * The media worker as main.ts runs it, but with a photo handler that runs a long ffmpeg, so a test
 * can stop it mid-job. src/worker/runtime.test.ts bundles this with the worker's own build and runs
 * it in a process of its own, on the test database, with its job queue in HARNESS_QUEUE_SCHEMA.
 */
import { fileURLToPath } from "node:url";
import { PgBoss } from "pg-boss";
import { dbConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { errorMessage } from "@/lib/log-error";
import { workerConfig } from "@/worker/config";
import { runningProcessIds, runProcess } from "@/worker/processes";
import { runWorker } from "@/worker/runtime";

const queueSchema = process.env.HARNESS_QUEUE_SCHEMA;
if (!queueSchema) throw new Error("Set HARNESS_QUEUE_SCHEMA");

await runWorker({
  config: workerConfig(),
  migrationsFolder: fileURLToPath(new URL("./drizzle", import.meta.url)),
  queueSchema,
  startQueue: async () => {
    const boss = new PgBoss({ ...dbConfig(), schema: queueSchema, max: 4, connectionTimeoutMillis: 5000 });
    boss.on("error", (error) => console.error("Job queue error:", errorMessage(error)));
    await boss.start();
    return boss;
  },
  handlers: {
    [MEDIA_QUEUES.photo]: async (job) => {
      // Ten minutes of video read in real time: it runs until something stops it.
      const converting = runProcess(
        "ffmpeg",
        [
          ...["-hide_banner", "-loglevel", "error", "-nostdin", "-re"],
          ...["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "600"],
          ...["-c:v", "libx264", "-preset", "ultrafast", "-threads", "1", "-f", "null", "-"],
        ],
        { signal: job.signal, timeoutMilliseconds: 15 * 60_000, priority: "background" },
      );
      console.log(JSON.stringify({ processIds: runningProcessIds() }));
      await converting;
    },
  },
});
