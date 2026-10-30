import { randomBytes, randomUUID } from "node:crypto";
import { DeleteObjectsCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { eq, inArray } from "drizzle-orm";
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
import { createSweeper, stuckConversionsQuery, stuckUploadsQuery } from "./sweeper";

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

  /**
   * The plan Postgres would use for the query once it is prepared and run with any values (a
   * generic plan). The test table is nearly empty, so sequential scans are put out of reach, as
   * they would be with a full one.
   */
  async function genericPlan(query: { toSQL(): { sql: string } }): Promise<string> {
    const { sql: text } = query.toSQL();
    const rows = await client.begin(async (transaction) => {
      await transaction`set local enable_seqscan = off`;
      return transaction.unsafe(`explain (generic_plan) ${text}`).simple();
    });
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  it("find items stuck in uploaded through their partial index, and their jobs through pg-boss's", async () => {
    const plan = await genericPlan(stuckUploadsQuery(BOSS_SCHEMA, 100));
    expect(plan).toContain("media_uploaded_idx");
    expect(plan).toMatch(/job_common_i14|job_i14/);
    expect(plan).not.toContain("Seq Scan");
  });

  it("find conversions queued with no job through their partial index", async () => {
    const plan = await genericPlan(stuckConversionsQuery(BOSS_SCHEMA, 100));
    expect(plan).toContain("media_conversion_queued_idx");
    expect(plan).not.toContain("Seq Scan");
  });

  it("page through unfinished uploads in index order, with no sort", async () => {
    const plan = await genericPlan(
      unfinishedUploadsQuery({
        startedBefore: minutesAgo(30),
        startedAfter: minutesAgo(8 * 24 * 60),
        cursor: { startedAt: minutesAgo(60), id: randomUUID() },
        limit: 25,
      }),
    );
    expect(plan).toContain("media_unfinished_upload_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });
});
