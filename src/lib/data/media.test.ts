import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../../test/db";
import { createGuest } from "./guests";
import { isVisible } from "./media";

beforeEach(resetDb);

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
    expect(await isVisible(await addPhoto({ removedByUploader: true }))).toBe(false);
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
});
