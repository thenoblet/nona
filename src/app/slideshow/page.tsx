import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple, wedding } from "@/content/wedding";
import { getSiteContent } from "@/lib/content/get";
import { listMedia } from "@/lib/data/media";
import type { MediaItem } from "@/lib/data/types";
import { albumUrl, qrSvg } from "@/lib/qr";
import { MediaImage } from "@/components/album/MediaImage";
import { PauseMusic } from "@/components/slideshow/PauseMusic";
import { QrCode } from "@/components/slideshow/QrCode";
import { SlideshowStage, type Slide } from "@/components/slideshow/SlideshowStage";

export const metadata: Metadata = {
  title: "Slideshow",
  robots: { index: false },
};

/*
 * The venue TV: a 16:9 composition drawn at 1280 x 720 design pixels.
 * Inside the frame one spacing step is one design pixel scaled to the screen,
 * so `p-40` is 40 design pixels and the whole layout fills any 16:9 display.
 * Other shapes (a phone) letterbox on the cocoa ground.
 */
const frame = "[--spacing:min(0.078125vw,0.138889dvh)]";

export default function SlideshowPage() {
  return (
    <main className="grid h-dvh w-full place-items-center overflow-hidden bg-cocoa font-sans text-white">
      <PauseMusic />
      <div className={`${frame} flex h-720 w-1280 gap-40 p-40`}>
        <section aria-label="Latest shared moments" className="min-w-0 flex-1">
          <Suspense fallback={<StageFallback />}>
            <LiveStage />
          </Suspense>
        </section>

        <aside className="flex w-300 shrink-0 flex-col items-center justify-between py-12 text-center">
          <div className="flex flex-col items-center gap-8">
            <p className="m-0 font-script text-[calc(var(--spacing)*72)] leading-none text-ember">{couple.monogram}</p>
            <p className="m-0 text-[calc(var(--spacing)*13)] tracking-[0.3em] text-mist uppercase">{wedding.dateShort}</p>
          </div>

          <div className="flex flex-col items-center gap-14">
            <div className="bg-white p-12">
              <Suspense fallback={<div className="size-168 bg-white" />}>
                <AlbumQr />
              </Suspense>
            </div>
            <p className="m-0 font-serif text-[calc(var(--spacing)*28)] leading-tight">Add yours</p>
            <p className="m-0 text-[calc(var(--spacing)*14)] leading-normal text-mist">
              Scan to share your photos. They&apos;ll appear here.
            </p>
          </div>

          <Suspense fallback={<ThumbStrip items={[]} />}>
            <RecentThumbs />
          </Suspense>
        </aside>
      </div>
    </main>
  );
}

/** Newest first, skipping anything without a preview yet. */
async function recentMedia(): Promise<(MediaItem & { src: NonNullable<MediaItem["src"]> })[]> {
  await connection();
  const items = await listMedia();
  return items
    .filter((m): m is MediaItem & { src: NonNullable<MediaItem["src"]> } => m.src !== null)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

function ago(minutes: number) {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

async function LiveStage() {
  // TODO: live updates. Subscribe to new uploads with Server-Sent Events and put each
  // new moment at the front of the queue, instead of reading the list once per load.
  // Media first: it waits for the request, so the content is not read while prerendering.
  const items = await recentMedia();
  const { celebrations } = await getSiteContent();
  const newest = items[0] ? Date.parse(items[0].uploadedAt) : 0;

  const slides: Slide[] = items.map((m) => {
    const event = celebrations.find((celebration) => celebration.id === m.event)?.name ?? "";
    // TODO: measure against the real clock once uploads are live (sample times are in December).
    const minutes = Math.round((newest - Date.parse(m.uploadedAt)) / 60000);
    return {
      id: m.id,
      src: m.src,
      alt: m.alt,
      position: m.position,
      kind: m.kind,
      // "You" only makes sense on the uploader's own phone.
      by: m.uploaderName === "You" ? "[Guest]" : m.uploaderName,
      detail: `${event} · ${ago(minutes)}`,
    };
  });

  return <SlideshowStage slides={slides} />;
}

function StageFallback() {
  return (
    <div className="flex h-full items-center justify-center bg-mocha">
      <p className="m-0 text-[calc(var(--spacing)*14)] tracking-[0.24em] text-linen uppercase">Loading the latest moments</p>
    </div>
  );
}

async function AlbumQr() {
  const url = await albumUrl();
  const svg = await qrSvg(url, "QR code to the shared album");
  return <QrCode svg={svg} className="size-168" />;
}

async function RecentThumbs() {
  const items = await recentMedia();
  return <ThumbStrip items={items.slice(0, 4)} />;
}

function ThumbStrip({ items }: { items: MediaItem[] }) {
  return (
    <ul aria-label="Recently shared" className="m-0 grid w-full list-none grid-cols-4 gap-6 p-0">
      {[0, 1, 2, 3].map((i) => {
        const item = items[i];
        return (
          <li key={item?.id ?? i} className={`relative aspect-square overflow-hidden ${i % 2 ? "bg-mocha/75" : "bg-mocha"}`}>
            {item ? <MediaImage item={item} sizes="7vw" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
