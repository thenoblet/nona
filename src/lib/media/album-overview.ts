import { describeError } from "@/lib/log-error";
import { albumStats, countSharers, listAlbum } from "./album";
import { albumSummaryWords, countFor, type AlbumPage, type AlbumStats } from "./album-item";

/** What the home page shows of the album after the wedding (AfterAlbum). */
export type AlbumOverview = {
  /** The first page, or null when the album can't be read. */
  album: AlbumPage | null;
  /** Everyone's and the browser's own counts, or null when the album can't be read. */
  stats: AlbumStats | null;
  /** The line above it: "34 photos and 6 videos from 12 of you, all in one place." */
  summary: string;
};

/**
 * The album for the home page after the wedding: its first page and counts, read together, and the
 * line counting them. The count of who shared is read on its own: when only it fails, the line leaves
 * out "from N of you" and the album still shows. Failures are logged, never thrown.
 */
export async function readAlbumOverview(viewerGuestIds: readonly string[]): Promise<AlbumOverview> {
  const [read, sharers] = await Promise.all([
    Promise.all([listAlbum({ viewerGuestIds }), albumStats(viewerGuestIds)]).catch((error: unknown) => {
      console.error("[home] could not read the album:", describeError(error));
      return null;
    }),
    countSharers().catch((error: unknown) => {
      console.error("[home] could not count who shared:", describeError(error));
      return 0;
    }),
  ]);
  const [album, stats] = read ?? [null, null];
  const summary = albumSummaryWords(
    stats && { photos: countFor(stats, { kind: "photo" }), videos: countFor(stats, { kind: "video" }), sharers },
  );
  return { album, stats, summary };
}
