import Link from "next/link";
import { getSiteContent } from "@/lib/content/get";
import { getSetting, SETTING_DEFAULTS } from "@/lib/data/settings";
import { listAdminAlbum, readAdminCounts } from "@/lib/media/admin-album";
import { countsFor, parseAdminFilter, queryOf, type AdminCountRow } from "@/lib/media/admin-item";
import { countAdminWishes, listAdminWishes } from "@/lib/media/admin-wishes";
import { readSlideshowDelay } from "@/lib/media/slideshow-delay";
import { readUploadsSwitch } from "@/lib/media/uploads-switch";
import { AlbumBrowser } from "./AlbumBrowser";
import type { CelebrationOption } from "./ItemPanel";
import { PhotoSwitches } from "./PhotoSwitches";
import { WishesTable } from "./WishesTable";

/*
 * The admin Photos page's data (Task 17, gate B): the two switches and the TV delay, the Album and
 * Wishes tabs with their counts, then the album or the wishes. Render these only inside AdminGate.
 */

/** The celebrations as the site names them, then More moments. */
async function celebrationOptions(): Promise<CelebrationOption[]> {
  const { celebrations } = await getSiteContent();
  return [
    ...celebrations.map((celebration) => ({ id: celebration.id, name: celebration.name })),
    { id: "more" as const, name: "More moments" },
  ];
}

/** The switches' and the tabs' data, each read once: one query each, side by side. */
async function readTop(countRowsPromise: Promise<AdminCountRow[]>) {
  const [uploads, convertBacklog, delay, countRows, wishCount] = await Promise.all([
    readUploadsSwitch(),
    getSetting("convert_backlog", SETTING_DEFAULTS.convert_backlog),
    readSlideshowDelay(),
    countRowsPromise,
    countAdminWishes(),
  ]);
  const everything = countsFor(countRows, {});
  return {
    switches: (
      <PhotoSwitches
        uploads={{ open: uploads.open, closedAt: uploads.closedAt?.toISOString() ?? null }}
        backlog={{ on: convertBacklog === true, waiting: everything.chips.queued }}
        delay={delay}
      />
    ),
    albumCount: everything.total,
    wishCount,
  };
}

/** The Album and Wishes tabs, each with its count. */
function PhotosTabs({ current, albumCount, wishCount }: { current: "album" | "wishes"; albumCount: number; wishCount: number }) {
  return (
    <nav className="admin-subtabs" aria-label="Photos">
      <Link href="/admin/photos" aria-current={current === "album" ? "page" : undefined}>
        Album <span className="admin-count">{albumCount}</span>
      </Link>
      <Link href="/admin/photos/wishes" aria-current={current === "wishes" ? "page" : undefined}>
        Wishes <span className="admin-count">{wishCount}</span>
      </Link>
    </nav>
  );
}

/** The Album tab: the first page of the filter the address names (any it doesn't know reads as none). */
export async function PhotosAlbum({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const filter = parseAdminFilter(queryOf(await searchParams)) ?? {};
  const countRows = readAdminCounts();
  const [top, page, celebrations, rows] = await Promise.all([readTop(countRows), listAdminAlbum({ filter }), celebrationOptions(), countRows]);
  return (
    <>
      {top.switches}
      <PhotosTabs current="album" albumCount={top.albumCount} wishCount={top.wishCount} />
      <AlbumBrowser initialFilter={filter} initialPage={page} countRows={rows} celebrations={celebrations} />
    </>
  );
}

/** The Wishes tab: every wish but the deleted, newest first. */
export async function PhotosWishes() {
  const [top, page] = await Promise.all([readTop(readAdminCounts()), listAdminWishes({})]);
  return (
    <>
      {top.switches}
      <PhotosTabs current="wishes" albumCount={top.albumCount} wishCount={top.wishCount} />
      <WishesTable initialPage={page} />
    </>
  );
}
