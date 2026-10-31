import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple } from "@/content/wedding";
import { shareDefaults } from "@/lib/share";
import { getSiteContent } from "@/lib/content/get";
import { listMedia, SAMPLE_DEVICE } from "@/lib/data/media";
import { describeError } from "@/lib/log-error";
import { readUploadsSwitch, UPLOADS_GRACE_MILLISECONDS } from "@/lib/media/uploads-switch";
import { resolveMode } from "@/lib/mode";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { AlbumBrowser } from "@/components/album/AlbumBrowser";
import { SharingAs } from "@/components/album/SharingAs";
import { ShareButtons, ShareButtonsSkeleton, UploadProgress, UploadProvider } from "@/components/album/Upload";
import { SharingClosed } from "@/components/album/SharingClosed";
import { UploadsClosed } from "@/components/album/UploadsClosed";

export const metadata: Metadata = {
  title: "Album",
  description: "The shared photo and video album for Noblet and Nancy's wedding. No app, no sign-up.",
  openGraph: {
    ...shareDefaults,
    title: "Capture it with us · Noblet & Nancy",
    description: "Share your photos and videos from the wedding, straight from your phone. No app, no sign-up.",
    url: "/album",
  },
};

/** The shared album the table QR codes open. Phone layout first; the grid widens on larger screens. */
export default function AlbumPage({ searchParams }: PageProps<"/album">) {
  return (
    <main className="min-h-dvh bg-blush pb-28">
      <UploadProvider>
        <PhoneHeader
          right={
            <Link
              href="/wishes"
              className="ember-link py-3 text-[11px] uppercase tracking-[0.18em] text-white no-underline"
            >
              Wishes
            </Link>
          }
        >
          <Suspense fallback={<AlbumHeadBody sharing={{ state: "pending" }} />}>
            <AlbumHead searchParams={searchParams} />
          </Suspense>
        </PhoneHeader>

        {/* Empty (and hidden) until the guest sends something. */}
        <div className="relative mx-auto -mt-3.5 w-full max-w-xl px-4 empty:hidden sm:px-8">
          <UploadProgress />
        </div>
      </UploadProvider>

      <div className="mx-auto w-full max-w-3xl px-4 sm:px-8">
        <Suspense fallback={<GridSkeleton />}>
          <AlbumMedia />
        </Suspense>

        <div className="mt-7 mb-9 flex flex-wrap items-center justify-center gap-x-6.5 gap-y-3">
          <PillLink href="/slideshow" variant="cocoa">
            <span className="flex items-center gap-2.5">
              <Icon name="slideshow" size={15} className="text-ember" />
              Watch the slideshow
            </span>
          </PillLink>
          <TextLink href="/wishes" className="text-cocoa">
            Wishes wall
          </TextLink>
        </div>
      </div>
    </main>
  );
}

/** Whether guests may share now, and how: read at request time, as the couple's switch decides. */
type Sharing =
  | { state: "pending" }
  | { state: "open"; cameraFirst: boolean }
  /** Closed; after a close, `graceUntil` while uploads started before it may still finish. */
  | { state: "closed"; phase: "before" | "after"; graceUntil: string | null };

/**
 * The header's words and the share buttons, by the uploads switch: camera first on the wedding
 * weekend and the gallery first before and after (see src/lib/mode.ts); before the couple open
 * sharing, and once they close it, a plain note instead (gate A).
 */
async function AlbumHead({ searchParams }: Pick<PageProps<"/album">, "searchParams">) {
  await connection();
  const [{ mode }, uploads] = await Promise.all([
    searchParams,
    // Unreadable, the buttons show: the upload API, which fails closed, says so if sharing is shut.
    readUploadsSwitch().catch((error: unknown) => {
      console.error("[album] could not read the uploads switch:", describeError(error));
      return null;
    }),
  ]);
  // Request time: connection() above.
  const now = new Date();
  if (uploads && !uploads.open) {
    const graceEnds = uploads.closedAt ? uploads.closedAt.getTime() + UPLOADS_GRACE_MILLISECONDS : 0;
    const graceUntil = graceEnds > now.getTime() ? new Date(graceEnds).toISOString() : null;
    return <AlbumHeadBody sharing={{ state: "closed", phase: uploads.closedAt ? "after" : "before", graceUntil }} />;
  }
  return <AlbumHeadBody sharing={{ state: "open", cameraFirst: resolveMode(now, mode) === "day" }} />;
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
        {open ? <SharingAs /> : sharing.state === "pending" ? <div aria-hidden className="h-5 w-44 rounded-full bg-white/10" /> : null}
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

/** Read at request time so new uploads show up. */
async function AlbumMedia() {
  await connection();
  const [{ celebrations }, items] = await Promise.all([getSiteContent(), listMedia()]);
  // TODO: identify this phone with a device cookie instead of the sample device.
  // TODO: ask for the latest list every 30 s, as the slideshow does (pollSlides in
  // src/components/slideshow/feed.ts), so new uploads appear without a reload.
  return <AlbumBrowser celebrations={celebrations} items={items} myDevice={SAMPLE_DEVICE} />;
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
