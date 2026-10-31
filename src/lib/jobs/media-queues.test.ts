import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbConfig } from "@/lib/env";
import { CONVERT_PRIORITY, createMediaQueues, MEDIA_QUEUE_OPTIONS, MEDIA_QUEUES } from "./media-queues";

const allQueues = Object.values(MEDIA_QUEUES);
const jobQueues = allQueues.filter((name) => name !== MEDIA_QUEUES.dead);

describe("the media queues' options", () => {
  it("name the nine queues", () => {
    expect(MEDIA_QUEUES).toEqual({
      photo: "media.photo",
      jpeg: "media.jpeg",
      poster: "media.poster",
      wish: "media.wish",
      convert: "media.convert",
      playable: "media.playable",
      visibility: "media.visibility",
      card: "media.card",
      dead: "media.dead",
    });
    expect(Object.keys(MEDIA_QUEUE_OPTIONS).sort()).toEqual([...allQueues].sort());
  });

  it("are standard queues expecting a heartbeat every minute, every one of them", () => {
    for (const name of allQueues) {
      expect(MEDIA_QUEUE_OPTIONS[name], name).toMatchObject({ policy: "standard", heartbeatSeconds: 60 });
    }
  });

  it("retry a job's transient errors with backoff", () => {
    for (const name of jobQueues) {
      expect(MEDIA_QUEUE_OPTIONS[name], name).toMatchObject({
        retryLimit: 12,
        retryDelay: 30,
        retryBackoff: true,
        retryDelayMax: 1800,
      });
    }
  });

  it("retry media.dead's handler a few times a minute apart: pg-boss's dead-letter copies carry no retryDelayMax", () => {
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.dead]).toMatchObject({ retryBackoff: false, retryDelay: 60, retryLimit: 5 });
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.dead].retryDelayMax).toBeUndefined();
  });

  it("keep retrying a transient error for 3½ to 4 hours, well inside the job's retention", () => {
    // pg-boss 12's wait after a failed attempt with backoff (plans.js, failJobsBody): retryDelay
    // times 2^retryCount times (1 + jitter), jitter in [0, 1), capped at retryDelayMax.
    const { retryLimit = 0, retryDelay = 0, retryDelayMax = Infinity } = MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.photo];
    function totalWait(jitter: number): number {
      let seconds = 0;
      for (let retryCount = 0; retryCount < retryLimit; retryCount++) {
        seconds += Math.min(retryDelayMax, retryDelay * 2 ** Math.min(16, retryCount) * (1 + jitter));
      }
      return seconds;
    }
    const HOUR = 60 * 60;
    expect(totalWait(0)).toBeGreaterThan(3.5 * HOUR);
    expect(totalWait(1)).toBeLessThanOrEqual(4.1 * HOUR);
    // pg-boss deletes a job left waiting to retry after retentionSeconds (14 days by default).
    expect(totalWait(1)).toBeLessThan(14 * 24 * HOUR);
  });

  it("give a conversion four hours, a playable copy an hour and every other job 15 minutes, set explicitly so a drift is put right", () => {
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.convert].expireInSeconds).toBe(14_400);
    // A 2 GB original's download, copy and upload, with room for a slow day at R2.
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.playable].expireInSeconds).toBe(3_600);
    for (const name of allQueues.filter((name) => name !== MEDIA_QUEUES.convert && name !== MEDIA_QUEUES.playable)) {
      expect(MEDIA_QUEUE_OPTIONS[name].expireInSeconds, name).toBe(900);
    }
  });

  it("keep a playable copy's finished jobs 7 days: the sweeper sends a copy's job only to a video listed within 6 days that never had one", () => {
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.playable].deleteAfterSeconds).toBe(7 * 24 * 60 * 60);
  });

  it("put a conversion someone asked for at 20, the worker's on-demand floor, above the backlog's", () => {
    expect(CONVERT_PRIORITY).toEqual({ onDemand: 20, backlog: 0 });
  });

  it("send a job that runs out of retries to media.dead, which keeps its own", () => {
    for (const name of jobQueues) {
      expect(MEDIA_QUEUE_OPTIONS[name].deadLetter, name).toBe("media.dead");
    }
    expect(MEDIA_QUEUE_OPTIONS[MEDIA_QUEUES.dead].deadLetter).toBeUndefined();
  });
});

// A real pg-boss on the test database, in a schema of its own so the e2e app's queue is untouched.
const SCHEMA = "pgboss_media_queues_test";

async function dropSchema(): Promise<void> {
  const sql = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`drop schema if exists ${sql(SCHEMA)} cascade`;
  } finally {
    await sql.end();
  }
}

function startBoss(): Promise<PgBoss> {
  const boss = new PgBoss({
    ...dbConfig(),
    schema: SCHEMA,
    max: 2,
    connectionTimeoutMillis: 5000,
    supervise: false,
    schedule: false,
  });
  return boss.start();
}

describe("createMediaQueues", () => {
  let app: PgBoss;
  let worker: PgBoss;

  beforeAll(async () => {
    await dropSchema();
    app = await startBoss();
    worker = await startBoss();
  }, 30_000);

  afterAll(async () => {
    await app?.stop({ graceful: false });
    await worker?.stop({ graceful: false });
    await dropSchema();
  });

  async function expectQueuesAsConfigured(boss: PgBoss): Promise<void> {
    for (const name of allQueues) {
      const queue = await boss.getQueue(name);
      expect(queue, name).toMatchObject({ name, ...MEDIA_QUEUE_OPTIONS[name] });
      expect(queue?.deadLetter ?? undefined, name).toBe(MEDIA_QUEUE_OPTIONS[name].deadLetter);
    }
  }

  it("creates every media queue with its options", async () => {
    await createMediaQueues(app);
    await expectQueuesAsConfigured(app);
  });

  it("can run again, from the app and the worker at once", async () => {
    await createMediaQueues(app);
    await Promise.all([createMediaQueues(app), createMediaQueues(worker)]);
    await expectQueuesAsConfigured(worker);
  });

  it("brings a queue whose settings changed back to these options", async () => {
    await createMediaQueues(app);
    await app.updateQueue(MEDIA_QUEUES.photo, {
      retryLimit: 1,
      heartbeatSeconds: null,
      deadLetter: null,
      expireInSeconds: 60,
    });
    await createMediaQueues(app);
    await expectQueuesAsConfigured(app);
  });

  it("lets the app send to every media queue before any worker has run", async () => {
    await createMediaQueues(app);
    for (const name of allQueues) {
      await expect(app.send(name, { mediaId: "00000000-0000-4000-8000-000000000001" }), name).resolves.toEqual(
        expect.any(String),
      );
    }
  });
});
