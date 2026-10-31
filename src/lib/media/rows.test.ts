import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { build } from "esbuild";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { isVisible as isVisibleForApp } from "@/lib/data/media";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { dbConfig } from "@/lib/env";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../../test/db";
import {
  claimConversion,
  conversionIsOnDemand,
  findPlayableVideo,
  isVisible,
  markConversionDone,
  markConversionFailed,
  markConversionRequested,
  markPhotoReady,
  markProcessingFailed,
  markVideoReady,
  releaseConversion,
  coupleHiddenQuery,
  resumableUploadQuery,
  uploadQuery,
  type ProcessedPhoto,
  type ProcessedVideo,
} from "./rows";

/** A finished album photo from a new guest, with any of its columns changed. */
async function addPhoto(changes: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const guest = await createGuest("Ama");
  const id = randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "photo",
      guestId: guest.id,
      uploaderName: "Ama",
      celebration: "reception",
      originalKey: originalKey(id, "jpg"),
      originalFilename: "IMG_0001.jpg",
      sizeBytes: 3_500_000,
      contentType: "image/jpeg",
      status: "ready",
      uploadedAt: new Date(),
      listedAt: new Date(),
      ...changes,
    });
  return id;
}

describe("isVisible", () => {
  beforeEach(resetDb);

  it("is true for an item no one has hidden, removed or deleted", async () => {
    expect(await isVisible(await addPhoto())).toBe(true);
  });

  it("is true while an item is still uploading or processing: only hiding, removing and deleting count", async () => {
    expect(await isVisible(await addPhoto({ status: "uploading", uploadedAt: null, listedAt: null }))).toBe(true);
    expect(await isVisible(await addPhoto({ status: "uploaded", listedAt: null }))).toBe(true);
  });

  it("is false for an item the couple hid", async () => {
    expect(await isVisible(await addPhoto({ hiddenAt: new Date(), hiddenBy: "admin@example.com" }))).toBe(false);
  });

  it("is false for an item its uploader removed", async () => {
    const removed = { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true };
    expect(await isVisible(await addPhoto(removed))).toBe(false);
  });

  it("is false for a deleted item", async () => {
    expect(await isVisible(await addPhoto({ deletedAt: new Date() }))).toBe(false);
  });

  it("turns false as soon as an item is hidden", async () => {
    const id = await addPhoto();
    await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "admin@example.com" }).where(eq(media.id, id));
    expect(await isVisible(id)).toBe(false);
  });

  it("is false for an item that doesn't exist, or an id that isn't one", async () => {
    expect(await isVisible(randomUUID())).toBe(false);
    expect(await isVisible("sample-1")).toBe(false);
    expect(await isVisible("")).toBe(false);
  });

  it("is the one the app's data layer hands out", () => {
    expect(isVisibleForApp).toBe(isVisible);
  });
});

describe("the media worker's marks", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function readRow(id: string) {
    const [row] = await getDb()
      .select({
        status: media.status,
        failureReason: media.failureReason,
        conversion: media.conversion,
        conversionFailureReason: media.conversionFailureReason,
      })
      .from(media)
      .where(eq(media.id, id));
    return row;
  }

  it("marks an uploaded item whose processing failed for good failed, with its reason", async () => {
    const id = await addPhoto({ status: "uploaded", listedAt: null });
    expect(await markProcessingFailed(id, "corrupt")).toBe(true);
    expect(await readRow(id)).toMatchObject({ status: "failed", failureReason: "corrupt" });
  });

  it("never turns a ready item failed: a failed re-processing leaves it as the album shows it", async () => {
    const id = await addPhoto({ status: "ready" });
    expect(await markProcessingFailed(id, "processing-failed")).toBe(false);
    expect(await readRow(id)).toMatchObject({ status: "ready", failureReason: null });
  });

  it("marks a queued conversion failed with its reason, and never a done one", async () => {
    const queued = await addPhoto({ kind: "video", conversion: "queued" });
    const done = await addPhoto({ kind: "video", conversion: "done" });
    expect(await markConversionFailed(queued, "corrupt")).toBe(true);
    expect(await markConversionFailed(done, "corrupt")).toBe(false);
    expect(await readRow(queued)).toMatchObject({ status: "ready", conversion: "failed", conversionFailureReason: "corrupt" });
    expect(await readRow(done)).toMatchObject({ status: "ready", conversion: "done", conversionFailureReason: null });
  });
});

describe("markPhotoReady", () => {
  beforeEach(resetDb);

  const processed: ProcessedPhoto = {
    derived: { thumb: "derived/a/b/thumb.webp", view: "derived/a/b/view.webp" },
    derivedGeneration: 0,
    width: 4032,
    height: 3024,
    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    averageColor: "#8a7f74",
    capturedAt: new Date("2026-12-05T23:00:00Z"),
    celebration: "reception",
  };

  async function readRow(id: string) {
    const [row] = await getDb().select().from(media).where(eq(media.id, id));
    return row;
  }

  it("marks an uploaded photo ready with what its processing made, listed now, and returns its manifest's facts", async () => {
    const id = await addPhoto({ status: "uploaded", listedAt: null, celebration: "more" });
    const before = Date.now();

    const facts = await markPhotoReady(id, processed);

    expect(facts).toEqual({
      celebration: "reception",
      celebrationSetByAdmin: false,
      hiddenAt: null,
      hiddenBy: null,
      removedByUploader: false,
      deletedAt: null,
    });
    const row = await readRow(id);
    expect(row).toMatchObject({ ...processed, status: "ready", failureReason: null });
    expect(row.listedAt?.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("keeps an item's place in the album, and the celebration the couple moved it to", async () => {
    const listedAt = new Date("2026-12-05T12:00:00Z");
    const id = await addPhoto({ status: "uploaded", listedAt, celebration: "thanks", celebrationSetByAdmin: true });

    expect(await markPhotoReady(id, processed)).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
    expect(await readRow(id)).toMatchObject({ status: "ready", listedAt, celebration: "thanks" });
  });

  it("changes nothing, and returns null, for an item no longer uploaded, or hidden, removed or deleted (Ruling AG)", async () => {
    const ids = [
      await addPhoto({ status: "ready" }),
      await addPhoto({ status: "failed", listedAt: null }),
      await addPhoto({ status: "uploaded", listedAt: null, hiddenAt: new Date(), hiddenBy: "admin" }),
      await addPhoto({ status: "uploaded", listedAt: null, hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addPhoto({ status: "uploaded", listedAt: null, deletedAt: new Date() }),
    ];
    for (const id of ids) {
      const before = await readRow(id);
      expect(await markPhotoReady(id, processed), id).toBeNull();
      expect(await readRow(id), id).toEqual(before);
    }
    expect(await markPhotoReady(randomUUID(), processed)).toBeNull();
  });

  it("changes nothing for files made for an older generation: an unhide since the job read the item", async () => {
    const id = await addPhoto({ status: "uploaded", listedAt: null, derivedGeneration: 1 });
    const before = await readRow(id);

    expect(await markPhotoReady(id, processed)).toBeNull();
    expect(await readRow(id)).toEqual(before);
    expect(await markPhotoReady(id, { ...processed, derivedGeneration: 1 })).not.toBeNull();
  });
});

describe("markVideoReady", () => {
  beforeEach(resetDb);

  const processed: ProcessedVideo = {
    derived: { "poster-thumb": "derived/a/b/poster-thumb.webp", "poster-view": "derived/a/b/poster-view.webp" },
    derivedGeneration: 0,
    width: 1080,
    height: 1920,
    thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
    averageColor: "#8a7f74",
    capturedAt: new Date("2026-12-05T23:00:00Z"),
    celebration: "reception",
    durationSeconds: 12.5,
    videoCodec: "hevc",
    browserPlayable: false,
    needsConversion: true,
    tooLongToConvert: false,
  };

  function addVideo(changes: Partial<typeof media.$inferInsert> = {}) {
    return addPhoto({ kind: "video", contentType: "video/quicktime", status: "uploaded", listedAt: null, ...changes });
  }

  async function readRow(id: string) {
    const [row] = await getDb().select().from(media).where(eq(media.id, id));
    return row;
  }

  it("marks an uploaded video ready with its poster and probe, listed now, and queues its conversion", async () => {
    const id = await addVideo({ celebration: "more" });
    const before = Date.now();

    const marked = await markVideoReady(id, processed);

    expect(marked).toEqual({
      manifest: {
        celebration: "reception",
        celebrationSetByAdmin: false,
        hiddenAt: null,
        hiddenBy: null,
        removedByUploader: false,
        deletedAt: null,
      },
      conversionQueued: true,
      conversionOnDemand: false,
    });
    const { needsConversion, tooLongToConvert, ...columns } = processed;
    expect(needsConversion).toBe(true);
    expect(tooLongToConvert).toBe(false);
    const row = await readRow(id);
    expect(row).toMatchObject({ ...columns, status: "ready", failureReason: null, conversion: "queued" });
    expect(row.listedAt?.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("leaves the conversion alone for a video every phone plays", async () => {
    const id = await addVideo();

    const marked = await markVideoReady(id, { ...processed, browserPlayable: true, needsConversion: false });

    expect(marked?.conversionQueued).toBe(false);
    expect(await readRow(id)).toMatchObject({ status: "ready", browserPlayable: true, conversion: "none" });
  });

  it("fails, too-long, the conversion of a video longer than the worker converts, and queues none (Ruling AR)", async () => {
    const id = await addVideo();
    const playable = await addVideo();
    const done = await addVideo({ conversion: "done" });

    expect((await markVideoReady(id, { ...processed, tooLongToConvert: true }))?.conversionQueued).toBe(false);
    expect((await markVideoReady(playable, { ...processed, browserPlayable: true, tooLongToConvert: true }))?.conversionQueued).toBe(false);
    await markVideoReady(done, { ...processed, tooLongToConvert: true });

    for (const video of [id, playable]) {
      expect(await readRow(video)).toMatchObject({ status: "ready", conversion: "failed", conversionFailureReason: "too-long" });
    }
    expect(await readRow(done)).toMatchObject({ conversion: "done", conversionFailureReason: null });
  });

  it("sends no conversion the row has under way, done or failed: only a queued one is to be sent", async () => {
    for (const conversion of ["converting", "done", "failed"] as const) {
      const id = await addVideo({ conversion });

      const marked = await markVideoReady(id, processed);

      expect(marked?.conversionQueued, conversion).toBe(false);
      expect(await readRow(id), conversion).toMatchObject({ status: "ready", conversion });
    }
  });

  it("sends the conversion an unhide left queued, on demand for a highlight or a phone's ask", async () => {
    const backlog = await addVideo({ conversion: "queued" });
    const highlight = await addVideo({ conversion: "queued", highlight: true });
    const asked = await addVideo({ conversion: "queued", conversionRequestedAt: new Date() });
    const playable = await addVideo({ conversion: "queued" });

    expect(await markVideoReady(backlog, processed)).toMatchObject({ conversionQueued: true, conversionOnDemand: false });
    expect(await markVideoReady(highlight, processed)).toMatchObject({ conversionQueued: true, conversionOnDemand: true });
    expect(await markVideoReady(asked, processed)).toMatchObject({ conversionQueued: true, conversionOnDemand: true });
    // Queued is kept even for a video every phone plays: a phone asked for it, or the couple made it a highlight.
    expect(await markVideoReady(playable, { ...processed, browserPlayable: true, needsConversion: false })).toMatchObject({
      conversionQueued: true,
    });
    for (const id of [backlog, highlight, asked, playable]) expect(await readRow(id)).toMatchObject({ conversion: "queued" });
  });

  it("keeps an item's place in the album, and the celebration the couple moved it to", async () => {
    const listedAt = new Date("2026-12-05T12:00:00Z");
    const id = await addVideo({ listedAt, celebration: "thanks", celebrationSetByAdmin: true });

    expect((await markVideoReady(id, processed))?.manifest).toMatchObject({ celebration: "thanks", celebrationSetByAdmin: true });
    expect(await readRow(id)).toMatchObject({ status: "ready", listedAt, celebration: "thanks" });
  });

  it("changes nothing, and returns null, for an item no longer uploaded, or hidden, removed or deleted (Ruling AG)", async () => {
    const ids = [
      await addVideo({ status: "ready", listedAt: new Date() }),
      await addVideo({ status: "failed" }),
      await addVideo({ hiddenAt: new Date(), hiddenBy: "admin" }),
      await addVideo({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addVideo({ deletedAt: new Date() }),
      // Unhidden since the job read it: its files are of the old generation.
      await addVideo({ derivedGeneration: 1 }),
    ];
    for (const id of ids) {
      const before = await readRow(id);
      expect(await markVideoReady(id, processed), id).toBeNull();
      expect(await readRow(id), id).toEqual(before);
    }
    expect(await markVideoReady(randomUUID(), processed)).toBeNull();
  });
});

describe("a video's conversion (Task 11, Rulings AG and AQ)", () => {
  const conversionOf = async (id: string) => {
    const [row] = await getDb()
      .select({
        conversion: media.conversion,
        derived: media.derived,
        requestedAt: media.conversionRequestedAt,
        lease: media.conversionJobId,
      })
      .from(media)
      .where(eq(media.id, id));
    return row;
  };
  const addVideo = (changes: Partial<typeof media.$inferInsert> = {}) =>
    addPhoto({ kind: "video", contentType: "video/quicktime", conversion: "queued", ...changes });

  it("is claimed under one job's lease: converting, from queued; only that lease carries it on, through its retries", async () => {
    const id = await addVideo({ capturedAt: new Date("2026-12-05T23:00:00Z"), durationSeconds: 12.5 });
    const lease = randomUUID();

    expect(await claimConversion(id, lease)).toEqual({
      originalKey: originalKey(id, "jpg"),
      capturedAt: new Date("2026-12-05T23:00:00Z"),
      durationSeconds: 12.5,
      derivedGeneration: 0,
    });
    expect(await conversionOf(id)).toMatchObject({ conversion: "converting", lease });
    // A second job, whatever its attempt, finds nothing to do; the lease's own job carries it on.
    expect(await claimConversion(id, randomUUID())).toBeNull();
    expect(await claimConversion(id, lease)).not.toBeNull();
    expect((await conversionOf(id)).lease).toBe(lease);
  });

  it("is never claimed unless queued (or converting under the same lease), the video ready, and neither hidden nor deleted", async () => {
    const lease = randomUUID();
    const ids = [
      await addVideo({ conversion: "none" }),
      await addVideo({ conversion: "done" }),
      await addVideo({ conversion: "failed" }),
      await addVideo({ conversion: "converting", conversionJobId: randomUUID() }),
      await addVideo({ conversion: "converting", conversionJobId: null }),
      await addVideo({ status: "uploaded", listedAt: null }),
      await addVideo({ hiddenAt: new Date(), hiddenBy: "admin" }),
      await addVideo({ hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addVideo({ deletedAt: new Date() }),
      await addPhoto({ conversion: "queued" }),
    ];
    for (const id of ids) {
      const before = await conversionOf(id);
      expect(await claimConversion(id, lease), id).toBeNull();
      expect(await conversionOf(id), id).toEqual(before);
    }
    expect(await claimConversion(randomUUID(), lease)).toBeNull();
    expect(await claimConversion("not-an-id", lease)).toBeNull();
    expect(await claimConversion(await addVideo(), "not-a-lease")).toBeNull();
  });

  it("gives its lease up, back to queued, only from converting under that lease", async () => {
    const lease = randomUUID();
    const converting = await addVideo({ conversion: "converting", conversionJobId: lease });
    const otherLease = await addVideo({ conversion: "converting", conversionJobId: randomUUID() });
    const done = await addVideo({ conversion: "done", conversionJobId: lease });

    for (const id of [converting, otherLease, done]) await releaseConversion(id, lease);

    expect(await conversionOf(converting)).toMatchObject({ conversion: "queued", lease: null });
    expect((await conversionOf(otherLease)).conversion).toBe("converting");
    expect((await conversionOf(done)).conversion).toBe("done");
  });

  it("is marked done with its file's key beside the poster's, returning the manifest's facts, only under its lease while the video still wants it", async () => {
    const posters = { "poster-thumb": "derived/a/0000000000000000/poster-thumb.webp" };
    const lease = randomUUID();
    const id = await addVideo({ conversion: "converting", conversionJobId: lease, derived: posters });
    const videoKey = `derived/${id}/0123456789abcdef/video.mp4`;

    expect(await markConversionDone(id, randomUUID(), videoKey)).toBeNull();
    expect(await markConversionDone(id, lease, videoKey)).toMatchObject({ celebration: "reception", hiddenAt: null });
    expect(await conversionOf(id)).toMatchObject({ conversion: "done", derived: { ...posters, video: videoKey } });
    // A late job's mark changes nothing.
    expect(await markConversionDone(id, lease, "derived/x/1111111111111111/video.mp4")).toBeNull();
    expect((await conversionOf(id)).derived.video).toBe(videoKey);

    for (const changes of [
      { hiddenAt: new Date(), hiddenBy: "admin" },
      { deletedAt: new Date() },
      { conversion: "failed" as const },
      { conversion: "queued" as const },
    ]) {
      const other = await addVideo({ conversion: "converting", conversionJobId: lease, ...changes });
      expect(await markConversionDone(other, lease, videoKey), JSON.stringify(changes)).toBeNull();
      expect((await conversionOf(other)).derived.video).toBeUndefined();
    }
  });

  it("is asked for on demand once: the first ask marks it (queuing one that needed none), the rest change nothing", async () => {
    const queued = await addVideo();
    const none = await addVideo({ conversion: "none" });

    expect(await markConversionRequested(queued)).toBe(true);
    expect(await markConversionRequested(queued)).toBe(false);
    expect(await markConversionRequested(none)).toBe(true);

    expect(await conversionOf(queued)).toMatchObject({ conversion: "queued", requestedAt: expect.any(Date) });
    expect(await conversionOf(none)).toMatchObject({ conversion: "queued", requestedAt: expect.any(Date) });
    for (const changes of [{ conversion: "done" as const }, { conversion: "failed" as const }, { hiddenAt: new Date(), hiddenBy: "admin" }]) {
      const other = await addVideo(changes);
      expect(await markConversionRequested(other)).toBe(false);
      expect((await conversionOf(other)).requestedAt).toBeNull();
    }
  });

  it("is on demand when a phone asked for it or the couple made it a highlight", async () => {
    expect(await conversionIsOnDemand(await addVideo({ conversionRequestedAt: new Date() }))).toBe(true);
    expect(await conversionIsOnDemand(await addVideo({ highlight: true }))).toBe(true);
    expect(await conversionIsOnDemand(await addVideo())).toBe(false);
    expect(await conversionIsOnDemand(randomUUID())).toBe(false);
  });

  it("shows a phone only a ready, visible album video's conversion: its file's key once done, when it was asked for, why it failed", async () => {
    const videoKey = "derived/a/0123456789abcdef/video.mp4";
    const done = await addVideo({ conversion: "done", derived: { video: videoKey } });
    expect(await findPlayableVideo(done)).toEqual({ conversion: "done", videoKey, requestedAt: null, failureReason: null });
    const failed = await addVideo({ conversion: "failed", conversionFailureReason: "too-long" });
    expect(await findPlayableVideo(failed)).toMatchObject({ conversion: "failed", failureReason: "too-long" });
    expect(await findPlayableVideo(await addVideo())).toMatchObject({ conversion: "queued", videoKey: null });
    for (const changes of [
      { hiddenAt: new Date(), hiddenBy: "admin" },
      { deletedAt: new Date() },
      { status: "uploaded" as const },
      { purpose: "wish" as const },
      { kind: "photo" as const },
    ]) {
      expect(await findPlayableVideo(await addVideo(changes)), JSON.stringify(changes)).toBeNull();
    }
  });
});

describe("rows.ts's imports", () => {
  it("reach no next/ module and no image, so the media worker can bundle it", async () => {
    // The worker's bundle (Task 8) is built the same way: esbuild, packages left external.
    const result = await build({
      entryPoints: [fileURLToPath(new URL("./rows.ts", import.meta.url))],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      packages: "external",
      logLevel: "silent",
      // Loaded as nothing, so an image in the graph shows up in the metafile instead of failing the build.
      loader: { ".jpg": "empty", ".jpeg": "empty", ".png": "empty", ".webp": "empty", ".svg": "empty" },
    });
    const modules = Object.values(result.metafile.inputs).flatMap((input) => input.imports.map((imported) => imported.path));
    const files = Object.keys(result.metafile.inputs);
    expect(modules.filter((path) => path === "next" || path.startsWith("next/"))).toEqual([]);
    expect(files.filter((path) => /\.(jpe?g|png|webp|svg)$/i.test(path))).toEqual([]);
    expect(files.some((path) => path.endsWith("src/lib/db/schema.ts"))).toBe(true);
  });
});

describe("the upload API's lookups", () => {
  const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
  afterAll(() => client.end());

  /**
   * The plan Postgres would use for the query once it is prepared and run with any values (a
   * generic plan, as a pooled prepared statement gets after a few runs). The test table is nearly
   * empty, so sequential scans are put out of reach, as they would be with a full one.
   */
  async function genericPlan(query: { toSQL(): { sql: string } }): Promise<string> {
    const { sql: text } = query.toSQL();
    const rows = await client.begin(async (transaction) => {
      await transaction`set local enable_seqscan = off`;
      return transaction.unsafe(`explain (generic_plan) ${text}`).simple();
    });
    return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  }

  it("finds a guest's unfinished upload of a file through the partial resume index, under a generic plan", async () => {
    const plan = await genericPlan(
      resumableUploadQuery({ guestId: randomUUID(), purpose: "album", sizeBytes: 1000, fingerprint: "f".repeat(64) }),
    );
    // The index's condition (status = 'uploading') holds only because the query states it literally.
    expect(plan).toContain("media_resume_idx");
    expect(plan).not.toContain("Seq Scan");
    expect(plan).not.toContain("Sort");
  });

  it("Ruling AX: finds a file the couple hid through its own small partial index, under a generic plan", async () => {
    const plan = await genericPlan(coupleHiddenQuery({ sizeBytes: 1000, fingerprint: "f".repeat(64) }));
    expect(plan).toContain("media_couple_hidden_idx");
    expect(plan).not.toContain("Seq Scan");
  });

  it("finds an upload by its id through the primary key", async () => {
    const plan = await genericPlan(uploadQuery(randomUUID()));
    expect(plan).toContain("media_pkey");
    expect(plan).not.toContain("Seq Scan");
  });
});
