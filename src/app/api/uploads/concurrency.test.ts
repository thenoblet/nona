import { AsyncLocalStorage } from "node:async_hooks";
import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { setSetting } from "@/lib/data/settings";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { dbConfig, storageConfig } from "@/lib/env";
import { PART_SIZE_BYTES } from "@/lib/media/limits";
import { storageClient } from "@/lib/storage/client";
import { manifestKey } from "@/lib/storage/keys";
import { abortMultipart } from "@/lib/storage/objects";
import { resetDb } from "../../../../test/db";
import { asBrowser, newCookieJar, type CookieJar } from "../../../../test/next-cookies";
import { jsonRequest, newFingerprint, routeContext } from "../../../../test/uploads";

// The performance budget (global constraints): 50 guests starting at once all succeed, once
// each, with no lock waits or deadlocks, in a reasonable time; the app's own share of a request
// (everything but the R2 call) stays under 200 ms at p95. Runs against the local MinIO and test
// database: docker compose up -d db minio && npm run storage:init.
//
// One start costs about 5 ms of the event loop, most of it the AWS SDK building, signing and
// reading its two R2 calls. 50 at the same instant therefore queue behind each other's CPU work
// (the loop is ~98% busy for the ~250 ms the burst takes), which a request's "own" time below
// counts; alone, a start's own time is under 20 ms. The burst ceilings are generous, to catch a
// regression (a query per part, a lock) rather than a slow machine.

vi.mock("next/headers", () => import("../../../../test/next-cookies"));
vi.mock("next/server", () => ({ after: () => {}, connection: async () => {} }));
vi.mock("@/lib/content/get", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { getSiteContent: async () => contentDefaults };
});

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { POST as presignRoute } from "./[id]/parts/route";
import { POST as startRoute } from "./route";

const GUESTS = 50;

/**
 * Each request's R2 calls, as [start, end] times, so its own time can be told from the time it
 * waited on R2. The middleware below records every call made inside a request's context.
 */
const requestTiming = new AsyncLocalStorage<{ r2Calls: [number, number][] }>();

beforeAll(() => {
  storageClient().middlewareStack.add(
    (next) => async (args) => {
      const began = performance.now();
      try {
        return await next(args);
      } finally {
        requestTiming.getStore()?.r2Calls.push([began, performance.now()]);
      }
    },
    { step: "initialize", name: "testTiming" },
  );
});

/** How long the calls covered between them, overlapping calls counted once. */
function coveredMilliseconds(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((first, second) => first[0] - second[0]);
  let covered = 0;
  let reach = -Infinity;
  for (const [began, ended] of sorted) {
    if (ended <= reach) continue;
    covered += ended - Math.max(began, reach);
    reach = ended;
  }
  return covered;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

function summary(values: number[]): string {
  const rounded = (value: number) => Math.round(value);
  return `p50 ${rounded(percentile(values, 0.5))} ms, p95 ${rounded(percentile(values, 0.95))} ms, max ${rounded(Math.max(...values))} ms`;
}

type Timed<TResult> = { result: TResult; totalMs: number; ownMs: number };

/** Runs one request, timing it whole and without its R2 calls. */
async function timed<TResult>(request: () => Promise<TResult>): Promise<Timed<TResult>> {
  const timing = { r2Calls: [] as [number, number][] };
  const began = performance.now();
  const result = await requestTiming.run(timing, request);
  const totalMs = performance.now() - began;
  return { result, totalMs, ownMs: totalMs - coveredMilliseconds(timing.r2Calls) };
}

/** Watches the test database for lock waits while `during` runs; returns the most seen at once. */
async function mostLockWaits(during: () => Promise<void>): Promise<number> {
  const watcher = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  let watching = true;
  let most = 0;
  const watch = (async () => {
    while (watching) {
      const [{ waiting }] = await watcher<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks
        where not granted and database = (select oid from pg_database where datname = current_database())`;
      most = Math.max(most, waiting);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();
  try {
    await during();
  } finally {
    watching = false;
    await watch;
    await watcher.end();
  }
  return most;
}

async function deadlocks(): Promise<number> {
  const [row] = await getDb().execute<{ deadlocks: number }>(
    sql`select deadlocks::int as deadlocks from pg_stat_database where datname = current_database()`,
  );
  return row.deadlocks;
}

/** A browser with its own guest, as POST /api/guest makes it. */
async function guestBrowser(index: number): Promise<CookieJar> {
  const guest = await createGuest(`Guest ${index}`);
  const jar = newCookieJar();
  jar.values.set(guestCookieName(), signGuestIds([guest.id]));
  return jar;
}

function photoBody() {
  return {
    purpose: "album",
    filename: "IMG_0001.JPG",
    size: 3 * PART_SIZE_BYTES + 5,
    contentType: "image/jpeg",
    fingerprint: newFingerprint(),
    capturedAt: "2026-12-05T20:15:00.000Z",
  };
}

beforeEach(async () => {
  await resetDb();
  await setSetting("uploads_open", true);
});

// Before the next test's reset, so every test's uploads and manifests are removed from MinIO.
afterEach(async () => {
  const rows = await getDb()
    .select({ id: media.id, key: media.originalKey, uploadId: media.multipartUploadId })
    .from(media);
  await Promise.all(rows.map((row) => (row.uploadId ? abortMultipart(row.key, row.uploadId).catch(() => {}) : null)));
  if (rows.length > 0) {
    await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: storageConfig().privateBucket,
        Delete: { Objects: rows.map((row) => ({ Key: manifestKey(row.id) })), Quiet: true },
      }),
    );
  }
});

describe("the upload API under a burst", () => {
  it("starts 50 guests' uploads at once: every one succeeds, once, with no lock waits or deadlocks", async () => {
    const browsers = await Promise.all(Array.from({ length: GUESTS }, (_, index) => guestBrowser(index)));
    const bodies = browsers.map(() => photoBody());
    const deadlocksBefore = await deadlocks();

    let outcomes: Timed<{ status: number; mediaId: string }>[] = [];
    const began = performance.now();
    const waits = await mostLockWaits(async () => {
      outcomes = await Promise.all(
        browsers.map((jar, index) =>
          asBrowser(jar, () =>
            timed(async () => {
              const response = await startRoute(jsonRequest("/api/uploads", "POST", bodies[index]));
              return { status: response.status, mediaId: ((await response.json()) as { mediaId: string }).mediaId };
            }),
          ),
        ),
      );
    });
    const elapsedMs = performance.now() - began;

    console.info(
      `[budget] ${GUESTS} concurrent starts in ${Math.round(elapsedMs)} ms; per request ${summary(outcomes.map((outcome) => outcome.totalMs))}; ` +
        `without R2 ${summary(outcomes.map((outcome) => outcome.ownMs))}`,
    );
    expect(outcomes.map((outcome) => outcome.result.status)).toEqual(Array(GUESTS).fill(200));
    expect(percentile(outcomes.map((outcome) => outcome.ownMs), 0.95)).toBeLessThan(1_000);
    expect(waits).toBe(0);
    expect(await deadlocks()).toBe(deadlocksBefore);
    expect(elapsedMs).toBeLessThan(10_000);

    const rows = await getDb()
      .select({ id: media.id, guestId: media.guestId, fingerprint: media.fileFingerprint, uploadId: media.multipartUploadId })
      .from(media);
    expect(rows).toHaveLength(GUESTS);
    expect(new Set(rows.map((row) => row.guestId)).size).toBe(GUESTS);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(outcomes.map((outcome) => outcome.result.mediaId)));
    expect(new Set(rows.map((row) => row.fingerprint))).toEqual(new Set(bodies.map((body) => body.fingerprint)));
    for (const row of rows) expect(row.uploadId, row.id).toEqual(expect.any(String));
  }, 30_000);

  it("answers a start in under 200 ms at p95 apart from its R2 calls, when it isn't queued behind a burst", async () => {
    const browsers = await Promise.all(Array.from({ length: 20 }, (_, index) => guestBrowser(index)));
    const outcomes: Timed<number>[] = [];
    for (const jar of browsers) {
      outcomes.push(
        await asBrowser(jar, () =>
          timed(async () => (await startRoute(jsonRequest("/api/uploads", "POST", photoBody()))).status),
        ),
      );
    }
    console.info(
      `[budget] 20 starts one after another: per request ${summary(outcomes.map((outcome) => outcome.totalMs))}; ` +
        `without R2 ${summary(outcomes.map((outcome) => outcome.ownMs))}`,
    );
    expect(outcomes.map((outcome) => outcome.result)).toEqual(Array(20).fill(200));
    expect(percentile(outcomes.map((outcome) => outcome.ownMs), 0.95)).toBeLessThan(200);
  });

  it("presigns 20 calls at once for one guest's upload, refusing none, quickly", async () => {
    const [browser] = await Promise.all([guestBrowser(0)]);
    const started = await asBrowser(browser, () => startRoute(jsonRequest("/api/uploads", "POST", photoBody())));
    const { mediaId } = (await started.json()) as { mediaId: string };

    const outcomes = await asBrowser(browser, () =>
      Promise.all(
        Array.from({ length: 20 }, (_, call) =>
          timed(async () => {
            const response = await presignRoute(
              jsonRequest(`/api/uploads/${mediaId}/parts`, "POST", { partNumbers: [(call % 4) + 1] }),
              routeContext(mediaId),
            );
            return response.status;
          }),
        ),
      ),
    );
    console.info(`[budget] 20 concurrent presigns for one upload: ${summary(outcomes.map((outcome) => outcome.totalMs))}`);
    expect(outcomes.map((outcome) => outcome.result)).toEqual(Array(20).fill(200));
    // Presigning is local: no R2 call, so the whole request is the app's own time.
    expect(percentile(outcomes.map((outcome) => outcome.ownMs), 0.95)).toBeLessThan(200);
  });
});
