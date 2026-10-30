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
import { isVisible, resumableUploadQuery, uploadQuery } from "./rows";

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
