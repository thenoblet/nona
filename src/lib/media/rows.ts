import { and, eq, isNull } from "drizzle-orm";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";

/*
 * The media table's queries, shared by the app and the media worker. The worker bundles this file,
 * so it imports only the database, the schema and plain helpers: nothing from next/ and no images
 * (rows.test.ts checks).
 */

/**
 * Whether anyone may see or fetch the item: it isn't hidden, deleted or removed by its uploader.
 * Every presign, download, playback and slideshow path checks this first. An unknown id, or one
 * that isn't a UUID, is not visible.
 */
export async function isVisible(mediaId: string): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const [row] = await getDb()
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.id, mediaId),
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        eq(media.removedByUploader, false),
      ),
    )
    .limit(1);
  return row !== undefined;
}
