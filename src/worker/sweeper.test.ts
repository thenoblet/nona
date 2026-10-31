import { randomBytes, randomUUID } from "node:crypto";
import { DeleteObjectsCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { eq, inArray } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { dbConfig, storageConfig } from "@/lib/env";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { unfinishedUploadsQuery } from "@/lib/media/rows";
import { abortMultipart, completeMultipart, startMultipart } from "@/lib/storage/objects";
import { resetDb } from "../../test/db";
import { dropBossSchema, startTestBoss } from "../../test/uploads";
import {
  convertingConversionsQuery,
  createSweeper,
  liveJobsQuery,
  queuedConversionsQuery,
  uploadedItemsQuery,
  type SweepResult,
} from "./sweeper";

// These run against the local MinIO and test database: docker compose up -d db minio && npm run storage:init.

// The worker's job queue, played by a real pg-boss in a schema of its own. completeUpload queues a
// rescued upload's job through getBoss(), which in the worker is the same queue the sweeper has.
const queue = vi.hoisted(() => ({ boss: null as unknown }));
vi.mock("@/lib/jobs/boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/boss")>();
  return {
    ...real,
    getBoss: async () => {
      if (!queue.boss) throw new Error("The test queue isn't started");
      return queue.boss;
    },
  };
});

const BOSS_SCHEMA = "pgboss_worker_sweeper_test";
let boss: PgBoss;

const MINUTE = 60_000;

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * MINUTE);
}

/** An item's row, as the upload API and the worker leave it, plus whatever the test sets. */
async function insertItem(values: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = values.id ?? randomUUID();
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
      startedAt: minutesAgo(60),
      uploadedAt: minutesAgo(10),
      ...values,
    });
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await getDb().select({ status: media.status }).from(media).where(eq(media.id, id));
  return row?.status;
}

/** The live jobs (waiting, retrying or running) for this item on this queue. */
async function liveJobs(queueName: string, mediaId: string) {
  const jobs = await boss.findJobs<{ mediaId: string }>(queueName, { data: { mediaId } });
  return jobs.filter((job) => ["created", "retry", "active"].includes(job.state));
}

function sweeper() {
  return createSweeper({ boss, bossSchema: BOSS_SCHEMA });
}

beforeAll(async () => {
  boss = await startTestBoss(BOSS_SCHEMA);
  queue.boss = boss;
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await dropBossSchema(BOSS_SCHEMA);
});

beforeEach(async () => {
  await resetDb();
  for (const name of Object.values(MEDIA_QUEUES)) await boss.deleteAllJobs(name);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the sweeper's first step: items stuck in uploaded", () => {
  it("queues an item that has sat uploaded with no job for more than 5 minutes, on its own queue", async () => {
    const photo = await insertItem();
    const video = await insertItem({ kind: "video", contentType: "video/quicktime" });
    const wish = await insertItem({ purpose: "wish", kind: "audio", contentType: "audio/mp4" });

    const result = await sweeper().sweep();

    expect(result.requeuedUploads).toBe(3);
    expect(await liveJobs(MEDIA_QUEUES.photo, photo)).toHaveLength(1);
    expect(await liveJobs(MEDIA_QUEUES.poster, video)).toHaveLength(1);
    expect(await liveJobs(MEDIA_QUEUES.wish, wish)).toHaveLength(1);
  });

  it("leaves an item that has a job (waiting, retrying, or in the dead letter queue), and one uploaded just now", async () => {
    const waiting = await insertItem();
    await boss.send(MEDIA_QUEUES.photo, { mediaId: waiting });
    const deadLettered = await insertItem();
    await boss.send(MEDIA_QUEUES.dead, { mediaId: deadLettered });
    const justUploaded = await insertItem({ uploadedAt: minutesAgo(1) });

    const result = await sweeper().sweep();

    expect(result.requeuedUploads).toBe(0);
    expect(await liveJobs(MEDIA_QUEUES.photo, waiting)).toHaveLength(1);
    expect(await liveJobs(MEDIA_QUEUES.photo, deadLettered)).toHaveLength(0);
    expect(await liveJobs(MEDIA_QUEUES.photo, justUploaded)).toHaveLength(0);
  });

  it("leaves an uploaded item that is hidden or deleted: its processing waits for an unhide to queue it", async () => {
    const hidden = await insertItem({ hiddenAt: minutesAgo(8), hiddenBy: "admin" });
    const removed = await insertItem({ hiddenAt: minutesAgo(8), hiddenBy: "guest", removedByUploader: true });
    const deleted = await insertItem({ deletedAt: minutesAgo(8) });

    const result = await sweeper().sweep();

    expect(result.requeuedUploads).toBe(0);
    for (const mediaId of [hidden, removed, deleted]) {
      expect(await liveJobs(MEDIA_QUEUES.photo, mediaId), mediaId).toHaveLength(0);
    }
  });

  it("queues each item once: a second sweep finds its job", async () => {
    const photo = await insertItem();
    await sweeper().sweep();
    const second = await sweeper().sweep();
    expect(second.requeuedUploads).toBe(0);
    expect(await liveJobs(MEDIA_QUEUES.photo, photo)).toHaveLength(1);
  });

  it("queues at most one batch a sweep", async () => {
    await getDb()
      .insert(media)
      .values(
        Array.from({ length: 120 }, () => {
          const id = randomUUID();
          return {
            id,
            purpose: "album" as const,
            kind: "photo" as const,
            celebration: "more" as const,
            originalKey: originalKey(id, "jpg"),
            originalFilename: "IMG_0001.JPG",
            sizeBytes: 4000,
            contentType: "image/jpeg",
            status: "uploaded" as const,
            uploadedAt: minutesAgo(10),
          };
        }),
      );
    const first = await sweeper().sweep();
    expect(first.requeuedUploads).toBe(100);
    const second = await sweeper().sweep();
    expect(second.requeuedUploads).toBe(20);
  });
});

describe("the sweeper's first two steps read in one snapshot (Ruling AF)", () => {
  /** Waits until some session of the test database is waiting for a lock. */
  async function untilOneWaitsForALock(watcher: postgres.Sql): Promise<void> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [{ waiting }] = await watcher<{ waiting: number }[]>`
        select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      if (waiting > 0) return;
      if (Date.now() > deadline) throw new Error("No session waited for the lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("doesn't queue an item whose job finishes between its read of the items and its read of their jobs", async () => {
    const photo = await insertItem();
    await boss.send(MEDIA_QUEUES.photo, { mediaId: photo });
    const locker = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
    const watcher = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
    try {
      let sweeping: Promise<SweepResult> | undefined;
      await locker.begin(async (transaction) => {
        // The job finishes and its item becomes ready, in a transaction that also holds pg-boss's
        // job table: the sweep reads the items before this commits, then its read of the jobs
        // waits for the commit. Read apart, the jobs' read would see the job gone and queue it again.
        await transaction`lock table ${transaction(BOSS_SCHEMA)}.job in access exclusive mode`;
        await transaction`update ${transaction(BOSS_SCHEMA)}.job set state = 'completed', completed_on = now()
          where data ->> 'mediaId' = ${photo}`;
        await transaction`update media set status = 'ready', listed_at = now() where id = ${photo}`;
        sweeping = sweeper().sweep();
        await untilOneWaitsForALock(watcher);
      });
      const result = await sweeping;

      expect(result?.requeuedUploads).toBe(0);
      expect(await liveJobs(MEDIA_QUEUES.photo, photo)).toHaveLength(0);
    } finally {
      await locker.end();
      await watcher.end();
    }
  });
});

describe("the sweeper's first step at the wedding's volume (Ruling AC d)", () => {
  it("finds nothing to queue among 3,000 uploaded items that all have a waiting job, well inside its 10 s statement timeout", async () => {
    const ids = Array.from({ length: 3_000 }, () => randomUUID());
    await getDb()
      .insert(media)
      .values(
        ids.map((id) => ({
          id,
          purpose: "album" as const,
          kind: "photo" as const,
          celebration: "more" as const,
          originalKey: originalKey(id, "jpg"),
          originalFilename: "IMG_0001.JPG",
          sizeBytes: 4000,
          contentType: "image/jpeg",
          status: "uploaded" as const,
          uploadedAt: minutesAgo(10),
        })),
      );
    await boss.insert(
      MEDIA_QUEUES.photo,
      ids.map((mediaId) => ({ data: { mediaId } })),
    );
    // No ANALYZE: the planner's statistics are as stale as a burst leaves them, its worst case.

    const started = performance.now();
    const result = await sweeper().sweep();
    const sweepMilliseconds = performance.now() - started;

    expect(result.requeuedUploads).toBe(0);
    expect(sweepMilliseconds).toBeLessThan(500);
  });
});

describe("the sweeper's second step: conversions queued with no job", () => {
  it("queues a ready video's conversion again, on demand if someone asked for it, else in the backlog", async () => {
    const backlog = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(10) });
    const requested = await insertItem({
      kind: "video",
      status: "ready",
      conversion: "queued",
      listedAt: minutesAgo(60),
      conversionRequestedAt: minutesAgo(10),
    });
    const highlight = await insertItem({
      kind: "video",
      status: "ready",
      conversion: "queued",
      listedAt: minutesAgo(10),
      highlight: true,
    });

    const result = await sweeper().sweep();

    expect(result.requeuedConversions).toBe(3);
    const [backlogJob] = await liveJobs(MEDIA_QUEUES.convert, backlog);
    const [requestedJob] = await liveJobs(MEDIA_QUEUES.convert, requested);
    const [highlightJob] = await liveJobs(MEDIA_QUEUES.convert, highlight);
    expect(backlogJob.priority).toBe(CONVERT_PRIORITY.backlog);
    expect(requestedJob.priority).toBe(CONVERT_PRIORITY.onDemand);
    expect(highlightJob.priority).toBe(CONVERT_PRIORITY.onDemand);
  });

  it("leaves a conversion that has its job, one done, and one queued just now", async () => {
    const withJob = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(10) });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: withJob });
    await insertItem({ kind: "video", status: "ready", conversion: "done", listedAt: minutesAgo(10) });
    await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(1) });

    const result = await sweeper().sweep();

    expect(result.requeuedConversions).toBe(0);
    expect(await liveJobs(MEDIA_QUEUES.convert, withJob)).toHaveLength(1);
  });

  it("sends an on-demand conversion whose job was lost though a backlog job for it waits: the backlog may be switched off", async () => {
    // A phone asked 10 minutes ago, and the app's send failed; the poster's backlog job still waits.
    const asked = await insertItem({
      kind: "video",
      status: "ready",
      conversion: "queued",
      listedAt: minutesAgo(60),
      conversionRequestedAt: minutesAgo(10),
    });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: asked }, { priority: CONVERT_PRIORITY.backlog });
    // One whose on-demand job is waiting, and a backlog one with its backlog job: both left alone.
    const askedWithJob = await insertItem({
      kind: "video",
      status: "ready",
      conversion: "queued",
      listedAt: minutesAgo(60),
      conversionRequestedAt: minutesAgo(10),
    });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: askedWithJob }, { priority: CONVERT_PRIORITY.onDemand });
    const backlog = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(10) });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: backlog }, { priority: CONVERT_PRIORITY.backlog });

    const result = await sweeper().sweep();

    expect(result.requeuedConversions).toBe(1);
    expect((await liveJobs(MEDIA_QUEUES.convert, asked)).map((job) => job.priority).sort()).toEqual([
      CONVERT_PRIORITY.backlog,
      CONVERT_PRIORITY.onDemand,
    ]);
    expect(await liveJobs(MEDIA_QUEUES.convert, askedWithJob)).toHaveLength(1);
    expect(await liveJobs(MEDIA_QUEUES.convert, backlog)).toHaveLength(1);
  });

  it("leaves a hidden or deleted video's conversion alone, however many sweeps: its job would do nothing", async () => {
    const hidden = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(10), hiddenAt: minutesAgo(8), hiddenBy: "admin" });
    const removed = await insertItem({
      kind: "video",
      status: "ready",
      conversion: "queued",
      listedAt: minutesAgo(10),
      hiddenAt: minutesAgo(8),
      hiddenBy: "guest",
      removedByUploader: true,
    });
    const deleted = await insertItem({ kind: "video", status: "ready", conversion: "queued", listedAt: minutesAgo(10), deletedAt: minutesAgo(8) });

    for (let sweep = 0; sweep < 2; sweep += 1) {
      const result = await sweeper().sweep();
      expect(result.requeuedConversions).toBe(0);
    }
    for (const id of [hidden, removed, deleted]) expect(await liveJobs(MEDIA_QUEUES.convert, id)).toEqual([]);
  });
});

describe("the sweeper's second step: conversions left converting with no job to carry them on (Ruling AQ)", () => {
  async function conversionOf(id: string) {
    const [row] = await getDb()
      .select({ conversion: media.conversion, lease: media.conversionJobId })
      .from(media)
      .where(eq(media.id, id));
    return row;
  }
  const converting = (values: Partial<typeof media.$inferInsert> = {}) =>
    insertItem({ kind: "video", status: "ready", conversion: "converting", conversionJobId: randomUUID(), listedAt: minutesAgo(60), ...values });

  it("puts one whose job is gone back to queued, its lease given up, and queues it: on demand if a guest asked, else in the backlog", async () => {
    const backlog = await converting();
    const asked = await converting({ conversionRequestedAt: minutesAgo(30) });
    const highlight = await converting({ highlight: true });

    const result = await sweeper().sweep();

    expect(result).toMatchObject({ requeuedConversions: 3, recoveredConversions: 3 });
    for (const id of [backlog, asked, highlight]) expect(await conversionOf(id)).toEqual({ conversion: "queued", lease: null });
    expect((await liveJobs(MEDIA_QUEUES.convert, backlog)).map((job) => job.priority)).toEqual([CONVERT_PRIORITY.backlog]);
    expect((await liveJobs(MEDIA_QUEUES.convert, asked)).map((job) => job.priority)).toEqual([CONVERT_PRIORITY.onDemand]);
    expect((await liveJobs(MEDIA_QUEUES.convert, highlight)).map((job) => job.priority)).toEqual([CONVERT_PRIORITY.onDemand]);
    // The next sweep finds their jobs.
    expect((await sweeper().sweep()).requeuedConversions).toBe(0);
  });

  it("recovers an asked-for one whose only job waits in the backlog (perhaps behind the switch), and sends it on demand", async () => {
    const lease = randomUUID();
    const asked = await converting({ conversionJobId: lease, conversionRequestedAt: minutesAgo(30) });
    // Its own job, waiting to retry at the backlog's priority: once it runs it finds another lease, and does nothing.
    await boss.send(MEDIA_QUEUES.convert, { mediaId: asked }, { id: lease, priority: CONVERT_PRIORITY.backlog });

    const result = await sweeper().sweep();

    expect(result.recoveredConversions).toBe(1);
    expect(await conversionOf(asked)).toEqual({ conversion: "queued", lease: null });
    expect((await liveJobs(MEDIA_QUEUES.convert, asked)).map((job) => job.priority).sort((first, second) => first - second)).toEqual([
      CONVERT_PRIORITY.backlog,
      CONVERT_PRIORITY.onDemand,
    ]);
  });

  it("leaves one that a job will carry on: waiting to retry under its lease, running, on demand, or in the dead letter queue", async () => {
    // An asked-for one whose backlog job is running now: it is carrying the conversion on.
    const running = await converting({ conversionRequestedAt: minutesAgo(30) });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: running }, { priority: CONVERT_PRIORITY.backlog });
    const [fetched] = await boss.fetch(MEDIA_QUEUES.convert);
    expect(fetched.data).toEqual({ mediaId: running });
    const waiting = await converting();
    await boss.send(MEDIA_QUEUES.convert, { mediaId: waiting }, { priority: CONVERT_PRIORITY.backlog });
    const onDemand = await converting({ conversionRequestedAt: minutesAgo(30) });
    await boss.send(MEDIA_QUEUES.convert, { mediaId: onDemand }, { priority: CONVERT_PRIORITY.onDemand });
    const deadLettered = await converting();
    await boss.send(MEDIA_QUEUES.dead, { mediaId: deadLettered });
    const hidden = await converting({ hiddenAt: minutesAgo(8), hiddenBy: "admin" });

    const before = await Promise.all([waiting, running, onDemand, deadLettered, hidden].map(conversionOf));
    const result = await sweeper().sweep();

    expect(result.recoveredConversions).toBe(0);
    expect(await Promise.all([waiting, running, onDemand, deadLettered, hidden].map(conversionOf))).toEqual(before);
  });
});

describe("the sweeper's third step (Ruling W): uploads whose phone dropped at the very end", () => {
  const keys: string[] = [];
  const unfinished: { key: string; uploadId: string }[] = [];

  afterAll(async () => {
    for (const { key, uploadId } of unfinished) await abortMultipart(key, uploadId).catch(() => {});
    if (keys.length === 0) return;
    await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: storageConfig().privateBucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
  });

  beforeEach(async () => {
    // A fresh database's uploads are closed (Ruling M); these tests run with them open, as on the day.
    await setSetting("uploads_open", true);
  });

  /** An `uploading` row whose multipart upload holds `sentBytes` of its declared `sizeBytes`, in one part. */
  async function uploadingItem(options: {
    sizeBytes: number;
    sentBytes: number;
    startedAt: Date;
    completed?: boolean;
    purpose?: "album" | "wish";
  }) {
    const id = randomUUID();
    const key = originalKey(id, "jpg");
    keys.push(key);
    const uploadId = await startMultipart(key, "image/jpeg", {
      guestId: null,
      uploaderName: "Ama Owusu",
      originalFilename: "IMG_0001.JPG",
      startedAt: options.startedAt,
    });
    unfinished.push({ key, uploadId });
    const part = await storageClient().send(
      new UploadPartCommand({
        Bucket: storageConfig().privateBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: randomBytes(options.sentBytes),
      }),
    );
    if (options.completed) await completeMultipart(key, uploadId, [{ partNumber: 1, etag: part.ETag ?? "" }]);
    const wish = options.purpose === "wish";
    await insertItem({
      id,
      purpose: wish ? "wish" : "album",
      kind: wish ? "audio" : "photo",
      contentType: wish ? "audio/mp4" : "image/jpeg",
      originalKey: key,
      sizeBytes: options.sizeBytes,
      status: "uploading",
      uploadedAt: null,
      multipartUploadId: uploadId,
      startedAt: options.startedAt,
    });
    return id;
  }

  it("completes an upload R2 holds every part of, the original already joined, and leaves a partial one", async () => {
    const everyPartSent = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(40) });
    const alreadyJoined = await uploadingItem({
      sizeBytes: 4000,
      sentBytes: 4000,
      startedAt: minutesAgo(40),
      completed: true,
    });
    const partial = await uploadingItem({ sizeBytes: 8000, sentBytes: 4000, startedAt: minutesAgo(40) });

    const result = await sweeper().sweep();

    expect(result.rescuedUploads).toBe(2);
    expect(await statusOf(everyPartSent)).toBe("uploaded");
    expect(await liveJobs(MEDIA_QUEUES.photo, everyPartSent)).toHaveLength(1);
    expect(await statusOf(alreadyJoined)).toBe("uploaded");
    expect(await liveJobs(MEDIA_QUEUES.photo, alreadyJoined)).toHaveLength(1);
    expect(await statusOf(partial)).toBe("uploading");
    expect(await liveJobs(MEDIA_QUEUES.photo, partial)).toHaveLength(0);
  });

  it("leaves an upload younger than 30 minutes, whose phone may still be sending, and one with no upload id", async () => {
    const young = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(20) });
    const neverStarted = await insertItem({ status: "uploading", uploadedAt: null, startedAt: minutesAgo(40) });

    const result = await sweeper().sweep();

    expect(result.rescuedUploads).toBe(0);
    expect(await statusOf(young)).toBe("uploading");
    expect(await statusOf(neverStarted)).toBe("uploading");
  });

  describe("once the couple close uploads (Ruling Z): closing is a hard stop", () => {
    const HOUR = 60;

    async function closeUploads(closedMinutesAgo: number): Promise<void> {
      await setSetting("uploads_open", false);
      await setSetting("uploads_closed_at", minutesAgo(closedMinutesAgo).toISOString());
    }

    it("leaves a fully sent album upload as it is once the 24 hours after the close have passed", async () => {
      await closeUploads(25 * HOUR);
      const everyPartSent = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(26 * HOUR) });

      const result = await sweeper().sweep();

      expect(result).toMatchObject({ checkedUploads: 0, rescuedUploads: 0 });
      expect(await statusOf(everyPartSent)).toBe("uploading");
      expect(await liveJobs(MEDIA_QUEUES.photo, everyPartSent)).toHaveLength(0);
    });

    it("finishes, within the 24 hours, an album upload started before the close, but not one started after it", async () => {
      await closeUploads(1 * HOUR);
      const startedBefore = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(2 * HOUR) });
      const startedAfter = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(40) });

      const result = await sweeper().sweep();

      expect(result).toMatchObject({ checkedUploads: 1, rescuedUploads: 1 });
      expect(await statusOf(startedBefore)).toBe("uploaded");
      expect(await liveJobs(MEDIA_QUEUES.photo, startedBefore)).toHaveLength(1);
      expect(await statusOf(startedAfter)).toBe("uploading");
      expect(await liveJobs(MEDIA_QUEUES.photo, startedAfter)).toHaveLength(0);
    });

    it("still finishes a wish, which the switch doesn't govern", async () => {
      await closeUploads(25 * HOUR);
      const wish = await uploadingItem({
        sizeBytes: 4000,
        sentBytes: 4000,
        startedAt: minutesAgo(26 * HOUR),
        purpose: "wish",
      });

      const result = await sweeper().sweep();

      expect(result.rescuedUploads).toBe(1);
      expect(await statusOf(wish)).toBe("uploaded");
      expect(await liveJobs(MEDIA_QUEUES.wish, wish)).toHaveLength(1);
    });
  });

  it("checks a bounded batch each sweep, and the next sweep carries on where it stopped", async () => {
    const partials = [];
    for (let count = 0; count < 3; count += 1) {
      partials.push(await uploadingItem({ sizeBytes: 8000, sentBytes: 4000, startedAt: minutesAgo(50) }));
    }
    const complete = await uploadingItem({ sizeBytes: 4000, sentBytes: 4000, startedAt: minutesAgo(40) });
    const batchOfTwo = createSweeper({ boss, bossSchema: BOSS_SCHEMA, rescueBatchSize: 2 });

    const first = await batchOfTwo.sweep();
    expect(first).toMatchObject({ checkedUploads: 2, rescuedUploads: 0 });
    const second = await batchOfTwo.sweep();
    expect(second).toMatchObject({ checkedUploads: 2, rescuedUploads: 1 });
    expect(await statusOf(complete)).toBe("uploaded");
    const rows = await getDb().select({ status: media.status }).from(media).where(inArray(media.id, partials));
    expect(rows.map((row) => row.status)).toEqual(["uploading", "uploading", "uploading"]);
  });
});

describe("the sweeper's queries", () => {
  const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  afterAll(() => client.end());

  /** Rolls a plan's transaction back once its plan is read. */
  class PlanRead extends Error {
    constructor(readonly plan: string) {
      super("plan read");
    }
  }

  /**
   * The plan Postgres would use for the query once it is prepared and run with any values (a
   * generic plan), on a media table like the wedding's: 3,000 items, nearly all ready and listed, a
   * tenth of them videos with a few conversions queued or under way, a few uploads in transit, a
   * few hidden. They are written and ANALYZEd in a transaction that is rolled back, so neither the
   * rows nor their statistics outlive it, and no statistics another test left (an autoanalyze of
   * a table full of one test's uploads) can sway the plan. Sequential scans are put out of reach,
   * as they would be on a full table.
   */
  async function genericPlan(query: { sql: string }): Promise<string> {
    try {
      await client.begin(async (transaction) => {
        await transaction`insert into media (purpose, kind, celebration, original_key, original_filename, size_bytes,
            content_type, status, started_at, uploaded_at, listed_at, conversion, hidden_at, multipart_upload_id)
          select 'album', case when n % 10 = 0 then 'video' else 'photo' end, 'reception',
            'originals/' || gen_random_uuid() || '.jpg', 'IMG.JPG', 4000, 'image/jpeg',
            case when n % 100 = 1 then 'uploaded' when n % 100 = 2 then 'uploading' else 'ready' end,
            now() - n * interval '1 minute', now() - n * interval '1 minute',
            case when n % 100 in (1, 2) then null else now() - n * interval '1 minute' end,
            case when n % 10 <> 0 then 'none' when n % 300 = 0 then 'queued' when n % 700 = 0 then 'converting' else 'done' end,
            case when n % 250 = 0 then now() end,
            case when n % 100 = 2 then 'upload-' || n end
          from generate_series(1, 3000) as n`;
        await transaction`analyze media`;
        await transaction`set local enable_seqscan = off`;
        const rows = await transaction.unsafe(`explain (generic_plan) ${query.sql}`).simple();
        throw new PlanRead(rows.map((row) => String(row["QUERY PLAN"])).join("\n"));
      });
    } catch (error) {
      if (error instanceof PlanRead) return error.plan;
      throw error;
    }
    throw new Error("The plan's transaction ended without reading it");
  }

  it("take items stuck in uploaded oldest first, in their partial index's order, with no sort", async () => {
    const plan = await genericPlan(uploadedItemsQuery(1_000).toSQL());
    expect(plan).toContain("media_uploaded_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });

  it("take conversions queued with no job oldest first, in their partial index's order, with no sort", async () => {
    const plan = await genericPlan(queuedConversionsQuery(1_000).toSQL());
    expect(plan).toContain("media_conversion_queued_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });

  it("take conversions under way oldest first, in their partial index's order, with no sort", async () => {
    const plan = await genericPlan(convertingConversionsQuery(1_000).toSQL());
    expect(plan).toContain("media_conversion_converting_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });

  it("look up a batch's live jobs through pg-boss's index of live jobs by queue and state", async () => {
    const query = new PgDialect().sqlToQuery(
      liveJobsQuery(BOSS_SCHEMA, [MEDIA_QUEUES.photo, MEDIA_QUEUES.dead], [randomUUID(), randomUUID()]),
    );
    const plan = await genericPlan(query);
    expect(plan).toMatch(/job_common_i14|job_i14/);
    expect(plan).not.toContain("Seq Scan");
  });

  it("look up on-demand conversions' live jobs through the same index, their priority only a filter", async () => {
    const query = new PgDialect().sqlToQuery(
      liveJobsQuery(BOSS_SCHEMA, [MEDIA_QUEUES.convert, MEDIA_QUEUES.dead], [randomUUID()], CONVERT_PRIORITY.onDemand),
    );
    const plan = await genericPlan(query);
    expect(plan).toMatch(/job_common_i14|job_i14/);
    expect(plan).not.toContain("Seq Scan");
  });

  it("page through unfinished uploads in index order, with no sort", async () => {
    const plan = await genericPlan(
      unfinishedUploadsQuery({
        startedMoreThanMinutesAgo: 30,
        startedWithinMinutes: 8 * 24 * 60,
        cursor: { startedAt: minutesAgo(60), id: randomUUID() },
        limit: 25,
      }).toSQL(),
    );
    expect(plan).toContain("media_unfinished_upload_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });
});
