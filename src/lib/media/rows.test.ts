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
  isVisible,
  markConversionFailed,
  markPhotoReady,
  markProcessingFailed,
  markVideoReady,
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
      .select({ status: media.status, failureReason: media.failureReason, conversion: media.conversion })
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

  it("marks a queued conversion failed, and never a done one", async () => {
    const queued = await addPhoto({ kind: "video", conversion: "queued" });
    const done = await addPhoto({ kind: "video", conversion: "done" });
    expect(await markConversionFailed(queued)).toBe(true);
    expect(await markConversionFailed(done)).toBe(false);
    expect(await readRow(queued)).toMatchObject({ status: "ready", conversion: "failed" });
    expect(await readRow(done)).toMatchObject({ status: "ready", conversion: "done" });
  });
});

describe("markPhotoReady", () => {
  beforeEach(resetDb);

  const processed: ProcessedPhoto = {
    derived: { thumb: "derived/a/b/thumb.webp", view: "derived/a/b/view.webp" },
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
});

describe("markVideoReady", () => {
  beforeEach(resetDb);

  const processed: ProcessedVideo = {
    derived: { "poster-thumb": "derived/a/b/poster-thumb.webp", "poster-view": "derived/a/b/poster-view.webp" },
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
    });
    const { needsConversion, ...columns } = processed;
    expect(needsConversion).toBe(true);
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

  it("queues no conversion the row already has, queued or done: only the change from none sends a job", async () => {
    for (const conversion of ["queued", "converting", "done", "failed"] as const) {
      const id = await addVideo({ conversion });

      const marked = await markVideoReady(id, processed);

      expect(marked?.conversionQueued, conversion).toBe(false);
      expect(await readRow(id), conversion).toMatchObject({ status: "ready", conversion });
    }
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
    ];
    for (const id of ids) {
      const before = await readRow(id);
      expect(await markVideoReady(id, processed), id).toBeNull();
      expect(await readRow(id), id).toEqual(before);
    }
    expect(await markVideoReady(randomUUID(), processed)).toBeNull();
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

  it("finds an upload by its id through the primary key", async () => {
    const plan = await genericPlan(uploadQuery(randomUUID()));
    expect(plan).toContain("media_pkey");
    expect(plan).not.toContain("Seq Scan");
  });
});
