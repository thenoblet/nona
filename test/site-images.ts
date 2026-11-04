import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { readSiteImages, type SiteImageRow } from "@/lib/site-images/store";
import { originalKey } from "@/lib/storage/keys";

/*
 * Site photos for tests (Task 19): a photo the couple uploaded from the admin (purpose "site"), as
 * the worker leaves it once processed, against the test database.
 */

/** The four sizes a site photo's processing names. */
export function sitePhotoKeys(mediaId: string): Record<string, string> {
  const folder = `derived/${mediaId}/fedcba9876543210`;
  return {
    thumb: `${folder}/thumb.webp`,
    view: `${folder}/view.webp`,
    medium: `${folder}/medium.webp`,
    large: `${folder}/large.webp`,
  };
}

/** Inserts a site photo, ready (or as given), 3000 × 2000 unless given, and returns its id. */
export async function addSitePhoto(overrides: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = overrides.id ?? randomUUID();
  const status = overrides.status ?? "ready";
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "site",
      kind: "photo",
      guestId: null,
      uploaderName: null,
      celebration: "more",
      originalKey: originalKey(id, "jpg"),
      originalFilename: "pre-wedding-01.jpg",
      sizeBytes: 6_400_000,
      contentType: "image/jpeg",
      status,
      uploadedAt: new Date("2026-11-01T10:00:00Z"),
      derived: status === "ready" ? sitePhotoKeys(id) : {},
      width: status === "ready" ? 3000 : null,
      height: status === "ready" ? 2000 : null,
      thumbhash: status === "ready" ? "1QcSHQRnh493V4dIh4eXh1h4kJUI" : null,
      averageColor: status === "ready" ? "#6b5a52" : null,
      ...overrides,
    });
  return id;
}

/** The slot's live row (its newest), or null while it shows its built-in photo unedited. */
export async function readLiveSiteImage(slot: string): Promise<SiteImageRow | null> {
  return (await readSiteImages(slot))[0] ?? null;
}
