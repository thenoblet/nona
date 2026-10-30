import { randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../test/db";
import { dropBossSchema, startTestBoss } from "../../test/uploads";
import { runProcess } from "./processes";
import {
  PermanentJobError,
  startQueueWorkers,
  type MediaHandlers,
  type QueueWorkers,
} from "./queues";

// A real pg-boss on the test database, in a schema of its own.
const BOSS_SCHEMA = "pgboss_worker_queues_test";
let boss: PgBoss;
let workers: QueueWorkers | null = null;

const ONE_EACH = {
  photo: 1,
  jpeg: 1,
  poster: 1,
  wish: 1,
  visibility: 1,
  card: 1,
  convertOnDemand: 1,
  convertBacklog: 1,
};

/** Starts the workers for the queues a test gives handlers; the others have none, as in production until their task. */
async function start(handlers: MediaHandlers, concurrency = ONE_EACH): Promise<QueueWorkers> {
  workers = await startQueueWorkers(boss, handlers, concurrency, { pollingIntervalSeconds: 0.5 });
  return workers;
}

/** An uploaded item's row, as the upload API leaves it, plus whatever the test sets. */
async function insertItem(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "photo",
      guestId: null,
      uploaderName: "Ama Owusu",
      celebration: "more",
      originalKey: originalKey(id, "jpg"),
      originalFilename: "IMG_0001.JPG",
      sizeBytes: 4000,
      contentType: "image/jpeg",
      status: "uploaded",
      uploadedAt: new Date(),
      ...values,
    });
  return id;
}

async function readItem(id: string) {
  const [row] = await getDb()
    .select({ status: media.status, failureReason: media.failureReason, conversion: media.conversion })
    .from(media)
    .where(eq(media.id, id));
  return row;
}

/** Polls until `check` passes or `timeoutMilliseconds` runs out, then runs it once more to report. */
async function eventually(check: () => Promise<void>, timeoutMilliseconds = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function jobState(queue: string, jobId: string): Promise<string | undefined> {
  const [job] = await boss.findJobs(queue, { id: jobId });
  return job?.state;
}

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
});

beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  workers?.stopFetching();
  workers = null;
  // Wait for the stopped workers' loops to end, and empty every queue for the next test.
  await new Promise((resolve) => setTimeout(resolve, 600));
  for (const queue of Object.values(MEDIA_QUEUES)) await boss.deleteAllJobs(queue);
  vi.restoreAllMocks();
});

describe("a job that fails for good", () => {
  it("fails at once on a permanent error (a corrupt file), with no retries, and sets its item failed with the reason", async () => {
    let attempts = 0;
    await start({
      [MEDIA_QUEUES.photo]: async () => {
        attempts += 1;
        throw new PermanentJobError("corrupt", "Not an image: the bytes are no photo format");
      },
    });
    const mediaId = await insertItem();
    const jobId = await boss.send(MEDIA_QUEUES.photo, { mediaId });

    await eventually(async () => expect(await readItem(mediaId)).toMatchObject({ status: "failed", failureReason: "corrupt" }));
    expect(attempts).toBe(1);
    expect(await jobState(MEDIA_QUEUES.photo, jobId ?? "")).toBe("failed");
  });

  it("sets its item failed once a transient error has used up its retries (the dead letter)", async () => {
    await start({
      [MEDIA_QUEUES.poster]: async () => {
        throw new Error("R2 answered 503");
      },
    });
    const mediaId = await insertItem({ kind: "video", contentType: "video/quicktime" });
    // No retries left from the start, so the first failure is the last.
    await boss.send(MEDIA_QUEUES.poster, { mediaId }, { retryLimit: 0 });

    await eventually(async () =>
      expect(await readItem(mediaId)).toMatchObject({ status: "failed", failureReason: "processing-failed" }),
    );
  });

  it("marks only the conversion failed when a conversion fails for good: the item keeps its poster", async () => {
    await start({
      [MEDIA_QUEUES.convert]: async () => {
        throw new PermanentJobError("corrupt", "ffmpeg could not decode the video");
      },
    });
    const mediaId = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: new Date() });
    await boss.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.onDemand });

    await eventually(async () => expect(await readItem(mediaId)).toMatchObject({ status: "ready", conversion: "failed" }));
  });

  it("leaves the item as it was when a hide fails for good, and says so in the log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await start({
      [MEDIA_QUEUES.visibility]: async () => {
        throw new PermanentJobError("purge-refused", "Cloudflare refused the purge");
      },
    });
    const mediaId = await insertItem({ status: "ready", listedAt: new Date(), hiddenAt: new Date() });
    await boss.send(MEDIA_QUEUES.visibility, { action: "hide", mediaId });

    await eventually(async () =>
      expect(errors.mock.calls.flat().join(" ")).toContain(`media.visibility job for ${mediaId} failed for good`),
    );
    expect(await readItem(mediaId)).toMatchObject({ status: "ready" });
  });

  it("leaves a ready item ready when its re-processing fails for good, and never logs it as marked failed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await start({
      [MEDIA_QUEUES.photo]: async () => {
        throw new PermanentJobError("corrupt", "Not an image: the bytes are no photo format");
      },
    });
    const mediaId = await insertItem({ status: "ready", listedAt: new Date() });
    await boss.send(MEDIA_QUEUES.photo, { mediaId });

    await eventually(async () =>
      expect(errors.mock.calls.flat().join(" ")).toContain(`media.photo job for ${mediaId} failed for good (corrupt): left as it was`),
    );
    expect(errors.mock.calls.flat().join(" ")).not.toContain("marked failed");
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", failureReason: null });
  });

  it("leaves a conversion that is done as it is when a re-conversion fails for good, and never logs it as marked failed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await start({
      [MEDIA_QUEUES.convert]: async () => {
        throw new PermanentJobError("corrupt", "ffmpeg could not decode the video");
      },
    });
    const mediaId = await insertItem({ kind: "video", status: "ready", conversion: "done", listedAt: new Date() });
    await boss.send(MEDIA_QUEUES.convert, { mediaId }, { priority: CONVERT_PRIORITY.onDemand });

    await eventually(async () =>
      expect(errors.mock.calls.flat().join(" ")).toContain(`media.convert job for ${mediaId} failed for good (corrupt): left as it was`),
    );
    expect(errors.mock.calls.flat().join(" ")).not.toContain("marked failed");
    expect(await readItem(mediaId)).toMatchObject({ status: "ready", conversion: "done" });
  });
});

describe("a queue with no handler yet (Ruling AA)", () => {
  it("leaves its job waiting, unfailed, for the release that brings its handler, and says so once at start", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // Only visibility has a handler, so the photo queue has none.
    await start({ [MEDIA_QUEUES.visibility]: async () => {} });
    expect(log.mock.calls.map((call) => call.join(" ")).join("\n")).toMatch(/no handler yet for .*media\.photo/);

    const mediaId = await insertItem();
    const jobId = await boss.send(MEDIA_QUEUES.photo, { mediaId });
    // Several of the test's half-second polls, and the dead letter queue's.
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(await jobState(MEDIA_QUEUES.photo, jobId ?? "")).toBe("created");
    expect(await readItem(mediaId)).toMatchObject({ status: "uploaded", failureReason: null });
  });
});

describe("each job's log line", () => {
  it("gives its queue, ids, duration, size and kind, and never the guest's name or the file's", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await start({ [MEDIA_QUEUES.photo]: async () => ({ sizeBytes: 4000, kind: "photo" }) });
    const mediaId = await insertItem();
    const jobId = await boss.send(MEDIA_QUEUES.photo, { mediaId });

    await eventually(async () => expect(await jobState(MEDIA_QUEUES.photo, jobId ?? "")).toBe("completed"));
    const line = log.mock.calls.map((call) => call.join(" ")).find((text) => text.includes(`job=${jobId}`));
    expect(line).toMatch(new RegExp(`media\\.photo completed in \\d+ ms job=${jobId} media=${mediaId} size=4000 kind=photo`));
    expect(line).not.toContain("Ama");
    expect(line).not.toContain("IMG_0001");
  });
});

describe("the conversion workers", () => {
  it("take on-demand requests while the backlog switch is off, and the backlog only once it is on", async () => {
    await setSetting("convert_backlog", false);
    const converted: string[] = [];
    const running = await start({
      [MEDIA_QUEUES.convert]: async (job) => {
        converted.push(String(job.data.mediaId));
      },
    });
    const backlogItem = randomUUID();
    const onDemandItem = randomUUID();
    await boss.send(MEDIA_QUEUES.convert, { mediaId: backlogItem }, { priority: CONVERT_PRIORITY.backlog });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: onDemandItem }, { priority: CONVERT_PRIORITY.onDemand });

    await eventually(async () => expect(converted).toEqual([onDemandItem]));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(converted).toEqual([onDemandItem]);

    await setSetting("convert_backlog", true);
    await running.followBacklogSwitch();
    await eventually(async () => expect(converted).toEqual([onDemandItem, backlogItem]));
  });
});

describe("Review Focus 4: photos stay fast while a video converts", () => {
  it("finishes a photo job in under 20 s while a 30-second conversion runs, nice'd, on every core", async () => {
    // One libvips thread per photo, as production sets it (WORKER_SHARP_THREADS, Ruling R).
    const sharpThreads = sharp.concurrency();
    sharp.concurrency(1);
    const stopConversion = new AbortController();
    let conversionStarted!: () => void;
    const conversionRunning = new Promise<void>((resolve) => (conversionStarted = resolve));
    let conversionEnded = false;

    await start({
      // A synthetic conversion: 30 s of 4K video through x264 on every core, under nice 19 as the
      // real ones run, so it keeps the machine busy for far longer than the photo takes.
      [MEDIA_QUEUES.convert]: async (job) => {
        const converting = runProcess(
          "ffmpeg",
          [
            ...["-hide_banner", "-loglevel", "error", "-nostdin"],
            ...["-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30", "-t", "30"],
            ...["-c:v", "libx264", "-preset", "medium", "-threads", String(availableParallelism())],
            ...["-f", "null", "-"],
          ],
          {
            signal: AbortSignal.any([job.signal, stopConversion.signal]),
            timeoutMilliseconds: 10 * 60_000,
            priority: "background",
          },
        );
        conversionStarted();
        try {
          await converting;
        } finally {
          conversionEnded = true;
        }
      },
      // A synthetic photo: a 12 MP image to a 1600 px and a 480 px WebP, at the worker's own priority.
      [MEDIA_QUEUES.photo]: async () => {
        const original = await sharp({
          create: {
            width: 4032,
            height: 3024,
            channels: 3,
            background: { r: 128, g: 128, b: 128 },
            noise: { type: "gaussian", mean: 128, sigma: 40 },
          },
        })
          .jpeg({ quality: 90 })
          .toBuffer();
        await sharp(original).rotate().resize(1600, 1600, { fit: "inside" }).webp({ quality: 80 }).toBuffer();
        await sharp(original).rotate().resize(480, 480, { fit: "inside" }).webp({ quality: 70 }).toBuffer();
        return { sizeBytes: original.length, kind: "photo" };
      },
    });

    try {
      await boss.send(MEDIA_QUEUES.convert, { mediaId: randomUUID() }, { priority: CONVERT_PRIORITY.onDemand });
      await conversionRunning;
      // Let ffmpeg take every core first.
      await new Promise((resolve) => setTimeout(resolve, 2_000));

      const sentAt = performance.now();
      const photoJob = await boss.send(MEDIA_QUEUES.photo, { mediaId: randomUUID() });
      await eventually(async () => expect(await jobState(MEDIA_QUEUES.photo, photoJob ?? "")).toBe("completed"), 30_000);
      const photoMilliseconds = performance.now() - sentAt;

      expect(photoMilliseconds).toBeLessThan(20_000);
      expect(conversionEnded).toBe(false);
    } finally {
      stopConversion.abort();
      sharp.concurrency(sharpThreads);
    }
  });
});
