import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple } from "@/content/wedding";
import { shareDefaults } from "@/lib/share";
import { listMedia, SAMPLE_DEVICE } from "@/lib/data/media";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { AlbumBrowser } from "@/components/album/AlbumBrowser";
import { SharingAs } from "@/components/album/SharingAs";
import { ShareMomentButton, UploadProgress, UploadProvider } from "@/components/album/Upload";

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
export default function AlbumPage() {
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
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p className="m-0 flex items-center gap-2.5 text-[11px] uppercase tracking-[0.3em] text-ember">
                <span className="live-dot" aria-hidden />
                Live album · {couple.hashtag}
              </p>
              <h1 className="m-0 font-script text-[54px] leading-[1.1] font-normal sm:text-6xl">Capture it with us</h1>
              <SharingAs />
            </div>
            <ShareMomentButton />
            <p className="-mt-1 mb-0 text-center text-xs tracking-[0.04em] text-mist">
              Photos and videos · no app, no sign-up
            </p>
          </div>
        </PhoneHeader>

        <div className="relative mx-auto -mt-3.5 w-full max-w-xl px-4 sm:px-8">
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
              Slideshow
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

/** Read at request time so new uploads show up. */
async function AlbumMedia() {
  await connection();
  const items = await listMedia();
  // TODO: identify this phone with a device cookie instead of the sample device.
  return <AlbumBrowser items={items} myDevice={SAMPLE_DEVICE} />;
}

function GridSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the album" className="pt-5.5">
      <div className="h-11 w-3/4 rounded-full bg-tray" />
      <div className="mt-3.5 h-13 rounded-full bg-tray sm:max-w-md" />
      <div className="mt-17 grid grid-cols-3 gap-1.5 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="aspect-square animate-pulse rounded-[2px] bg-tile" />
        ))}
      </div>
    </div>
  );
}
