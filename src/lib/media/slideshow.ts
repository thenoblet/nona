import { and, desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { publicUrl } from "@/lib/storage/keys";
import { visibleAlbumItems } from "./album";
import type { AlbumCelebration, AlbumKind } from "./album-item";

/*
 * The venue TV's moments (Task 20): the album's own, as everyone sees them (ready, never a wish,
 * never hidden, deleted or removed by its uploader), newest listed first, and only once they have
 * been listed for the TV delay (slideshow-delay.ts), so the couple can hide anything before the TV
 * shows it. The delay is the bound of a walk down media_album_cursor_idx, read by the database's
 * own clock (the one that listed them): moments listed since are never read, and nothing is sorted.
 */

/** The most moments the slideshow holds at once. */
export const SLIDESHOW_LIMIT = 60;

/** A moment the slideshow may show. */
export type SlideshowItem = {
  id: string;
  kind: AlbumKind;
  /** Its viewing size (a video's poster), at most 1600 px on its long edge, on the media domain. */
  view: string;
  /** Its size, upright; null when the worker didn't record one. */
  width: number | null;
  height: number | null;
  /** The name it was shared under; null for none. */
  by: string | null;
  celebration: AlbumCelebration;
  /** When it was listed, ISO, to the millisecond. */
  listedAt: string;
};

/**
 * The newest moments listed at least `delaySeconds` ago, with a viewing size to show. Exported so a
 * test can check its plan.
 */
export function slideshowQuery(delaySeconds: number) {
  return getDb()
    .select({
      id: media.id,
      kind: media.kind,
      uploaderName: media.uploaderName,
      celebration: media.celebration,
      listedAt: media.listedAt,
      width: media.width,
      height: media.height,
      derived: media.derived,
    })
    .from(media)
    .where(
      and(
        visibleAlbumItems(),
        sql`${media.status} = 'ready'`,
        sql`${media.listedAt} <= now() - make_interval(secs => ${delaySeconds})`,
      ),
    )
    .orderBy(desc(media.listedAt), desc(media.id))
    .limit(SLIDESHOW_LIMIT);
}

/**
 * The slideshow's moments, newest first: at most 60, each listed at least `delaySeconds` ago. A
 * ready moment always has its viewing size (a video, its poster's); one without is skipped here,
 * never sent to a screen as a picture it can't load. (Not in the query: Postgres can't tell how
 * many rows a test on `derived` keeps, and would sort the album rather than walk its index.)
 */
export async function listSlideshowItems(delaySeconds: number): Promise<SlideshowItem[]> {
  const rows = await slideshowQuery(delaySeconds);
  return rows.flatMap((row) => {
    const video = row.kind === "video";
    const view = video ? row.derived["poster-view"] : row.derived.view;
    if (!view || !row.listedAt || (row.kind !== "photo" && !video)) return [];
    return [
      {
        id: row.id,
        kind: video ? "video" : "photo",
        view: publicUrl(view),
        width: row.width,
        height: row.height,
        by: row.uploaderName,
        celebration: row.celebration,
        listedAt: row.listedAt.toISOString(),
      },
    ];
  });
}
