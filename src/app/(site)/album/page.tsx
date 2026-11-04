import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { cache, Suspense } from "react";
import { couple } from "@/content/wedding";
import { shareDefaults } from "@/lib/share";
import { getSiteContent } from "@/lib/content/get";
import { getSiteImages, storedCardImages } from "@/lib/site-images/get";
import { findGuestById } from "@/lib/data/guests";
import type { Guest } from "@/lib/data/types";
import { ownGuestId, personalLinkOf, readGuestIds } from "@/lib/guests/cookie";
import type { OwnGuest } from "@/components/album/guestName";
import { describeError } from "@/lib/log-error";
import { albumStats, listAlbum } from "@/lib/media/album";
import { readUploadsSwitch, UPLOADS_GRACE_MILLISECONDS } from "@/lib/media/uploads-switch";
import { resolveMode } from "@/lib/mode";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";
import { AlbumBrowser } from "@/components/album/AlbumBrowser";
import { SharingAs } from "@/components/album/SharingAs";
import { ShareButtons, ShareButtonsSkeleton, UploadProgress, UploadProvider } from "@/components/album/Upload";
import { SharingClosed } from "@/components/album/SharingClosed";
import { UploadsClosed } from "@/components/album/UploadsClosed";

/**
 * Read at request time (as the root layout's metadata already is): once the couple change the album
 * card's photo in the admin and the worker has drawn it, og:image is that card; until then, the
 * build-time one from opengraph-image.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return {
    title: "Album",
    description: "The shared photo and video album for Noblet and Nancy's wedding. No app, no sign-up.",
    openGraph: {
      ...shareDefaults,
      title: "Capture it with us · Noblet & Nancy",
      description: "Share your photos and videos from the wedding, straight from your phone. No app, no sign-up.",
      url: "/album",
      ...storedCardImages(await getSiteImages(), "album"),
    },
  };
}

/**
 * The shared album the table QR codes open. Phone layout first; the grid widens on larger screens.
 * The header holds the share buttons and, under them, the slideshow (gate B screen 7, option A);
 * Wishes stays top right.
 */
export default function AlbumPage({ searchParams }: PageProps<"/album">) {
  return (
    <main className="min-h-dvh bg-blush pb-28">
      <UploadProvider>
        <PhoneHeader sibling={{ href: "/wishes", text: "Wishes", icon: "heart" }}>
          <Suspense fallback={<AlbumHeadBody sharing={{ state: "pending" }} />}>
            <AlbumHead searchParams={searchParams} />
          </Suspense>
          <SlideshowRow />
        </PhoneHeader>

        {/* Empty (and hidden) until the guest sends something. */}
        <div className="relative mx-auto -mt-3.5 w-full max-w-xl px-4 empty:hidden sm:px-8">
          <UploadProgress />
        </div>

        {/* Marked so it slides with the upload card as the card morphs into its circle and back. */}
        <div data-upload-below className="mx-auto w-full max-w-3xl px-4 sm:px-8">
          <Suspense fallback={<GridSkeleton />}>
            <AlbumMedia searchParams={searchParams} />
          </Suspense>
        </div>
      </UploadProvider>
    </main>
  );
}

/**
 * Gate B screen 7, option A: one quiet row under the share buttons, seen on arrival. Not prefetched:
 * it sits in view as the page loads, and the slideshow's code shouldn't spend a guest's mobile data
 * before they ask for it.
 */
function SlideshowRow() {
  return (
    <Link
      href="/slideshow"
      prefetch={false}
      className="mt-4 flex min-h-14 items-center gap-3 border-t border-white/10 pt-3 text-white no-underline"
    >
      <Halo icon="slideshow" tone="dark" />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="font-serif text-xl leading-[1.15] italic">Watch the slideshow</span>
        <span className="truncate text-xs text-mist">Everyone&apos;s moments, one after another</span>
      </span>
      <Icon name="forward" size={18} className="shrink-0 text-ember" />
    </Link>
  );
}

/** Whether guests may share now, and how: read at request time, as the couple's switch decides. */
type Sharing =
  | { state: "pending" }
  /** `ownGuest`: the browser's own guest, whose name it shares as after a link took it over (Ruling CG). */
  | { state: "open"; cameraFirst: boolean; ownGuest: OwnGuest | null }
  /** Closed; after a close, `graceUntil` while uploads started before it may still finish. */
  | { state: "closed"; phase: "before" | "after"; graceUntil: string | null };

/**
 * The header's words and the share buttons, by the uploads switch: camera first on the wedding
 * weekend and the gallery first before and after (see src/lib/mode.ts); before the couple open
 * sharing, and once they close it, a plain note instead (gate A).
 */
async function AlbumHead({ searchParams }: Pick<PageProps<"/album">, "searchParams">) {
  await connection();
  const [{ mode }, uploads, ownGuest] = await Promise.all([
    searchParams,
    // Unreadable, the buttons show: the upload API, which fails closed, says so if sharing is shut.
    readUploadsSwitch().catch((error: unknown) => {
      console.error("[album] could not read the uploads switch:", describeError(error));
      return null;
    }),
    readOwnGuest(),
  ]);
  // Request time: connection() above.
  const now = new Date();
  if (uploads && !uploads.open) {
    const graceEnds = uploads.closedAt ? uploads.closedAt.getTime() + UPLOADS_GRACE_MILLISECONDS : 0;
    const graceUntil = graceEnds > now.getTime() ? new Date(graceEnds).toISOString() : null;
    return <AlbumHeadBody sharing={{ state: "closed", phase: uploads.closedAt ? "after" : "before", graceUntil }} />;
  }
  return <AlbumHeadBody sharing={{ state: "open", cameraFirst: resolveMode(now, mode) === "day", ownGuest }} />;
}

/**
 * The browser's own guest, read once a request (React's cache): the header's "Sharing as" and My
 * uploads' personal link both need it.
 */
const ownGuestOfRequest = cache(async (): Promise<Guest | null> => {
  const ownId = await ownGuestId();
  return ownId ? findGuestById(ownId) : null;
});

/** The browser's own guest and its name, for "Sharing as"; null for none, or when it can't be read. */
async function readOwnGuest(): Promise<OwnGuest | null> {
  try {
    const guest = await ownGuestOfRequest();
    return guest ? { id: guest.id, displayName: guest.displayName } : null;
  } catch (error) {
    // The error's name and code only: a query error carries its parameters.
    console.error("[album] could not read the browser's guest:", describeError(error));
    return null;
  }
}

/**
 * While the switch is read, only what is true either way: "Album", no live dot, and placeholders
 * the height of the open state's lines, so the weekend's page doesn't shift as they arrive.
 */
function AlbumHeadBody({ sharing }: { sharing: Sharing }) {
  const open = sharing.state === "open";
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <p className="m-0 flex items-center gap-2.5 text-[11px] uppercase tracking-[0.3em] text-ember">
          {open ? <span className="live-dot" aria-hidden /> : null}
          {open ? "Live album" : "Album"} · {couple.hashtag}
        </p>
        <h1 className="m-0 font-script text-[54px] leading-[1.1] font-normal sm:text-6xl">Capture it with us</h1>
        {sharing.state === "open" ? <SharingAs ownGuest={sharing.ownGuest} /> : sharing.state === "pending" ? <div aria-hidden className="h-5 w-44 rounded-full bg-white/10" /> : null}
      </div>
      {sharing.state === "closed" ? (
        sharing.phase === "after" ? (
          <SharingClosed graceUntil={sharing.graceUntil} />
        ) : (
          <UploadsClosed phase="before" />
        )
      ) : open ? (
        <ShareButtons cameraFirst={sharing.cameraFirst} />
      ) : (
        <ShareButtonsSkeleton />
      )}
      {open ? (
        <p className="-mt-1 mb-0 text-center text-xs tracking-[0.04em] text-mist">Photos and videos · no app, no sign-up</p>
      ) : sharing.state === "pending" ? (
        <div aria-hidden className="mx-auto -mt-1 h-4 w-56 rounded-full bg-white/5" />
      ) : null}
    </div>
  );
}

/**
 * The album's first page, read at request time with the browser's own guests (their moments read
 * as theirs, and only they see theirs not ready yet), the album's counts, and the guest's personal
 * link for My uploads. When the album can't be read, it says so and the header still shows.
 */
async function AlbumMedia({ searchParams }: Pick<PageProps<"/album">, "searchParams">) {
  await connection();
  const [{ view }, guestIds] = await Promise.all([searchParams, readGuestIds()]);
  const mine = view === "mine";
  const album = await Promise.all([
    getSiteContent(),
    listAlbum({ viewerGuestIds: guestIds, mine }),
    albumStats(guestIds),
    ownGuestOfRequest().then((guest) => (guest ? personalLinkOf(guest) : null)),
  ]).catch((error: unknown) => {
    console.error("[album] could not read the album:", describeError(error));
    return null;
  });
  if (!album) {
    return (
      <p className="mt-6 mb-0 rounded-[var(--radius-paper)] bg-white px-5 py-9 text-center font-serif text-xl text-mocha italic shadow-[var(--shadow-paper)]">
        The album can&apos;t load right now. Try again in a minute.
      </p>
    );
  }
  const [{ celebrations }, firstPage, stats, link] = album;
  return (
    <AlbumBrowser
      celebrations={celebrations.map((celebration) => celebration.id)}
      firstPage={firstPage}
      startMine={mine}
      stats={stats}
      personalLink={link}
    />
  );
}

function GridSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the album" className="pt-5.5">
      <div className="h-11 w-3/4 rounded-full bg-tray" />
      <div className="mt-3.5 h-13 rounded-full bg-tray sm:max-w-md" />
      <div className="mt-17 grid grid-cols-3 gap-1.5 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 9 }, (_tile, index) => (
          <div key={index} className="aspect-square animate-pulse rounded-[2px] bg-tile" />
        ))}
      </div>
    </div>
  );
}
