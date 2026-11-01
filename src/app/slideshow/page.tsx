import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { describeError } from "@/lib/log-error";
import { albumUrl, qrSvg } from "@/lib/qr";
import { PauseMusic } from "@/components/slideshow/PauseMusic";
import { Slideshow } from "@/components/slideshow/Slideshow";
import { loadSlides } from "./slides";

export const metadata: Metadata = {
  title: "Slideshow",
  robots: { index: false },
};

/**
 * Guests' newest photos and videos (a video by its poster), each shown once the TV delay has passed
 * (slides.ts). Landscape screens (the venue TV, laptops, a phone on its side) get the TV layout with
 * a QR code to the album; portrait phones get the photo full screen. The layout is chosen in CSS
 * (the `tv` variant in globals.css), never from the user agent.
 */
export default function SlideshowPage() {
  return (
    <main className="h-dvh w-full overflow-hidden bg-cocoa font-sans text-white">
      <PauseMusic />
      <Suspense fallback={<Slideshow slides={null} qrSvg={null} />}>
        <LiveSlideshow />
      </Suspense>
    </main>
  );
}

async function LiveSlideshow() {
  await connection();
  const [slides, qr] = await Promise.all([slidesOrNone(), albumQr()]);
  return <Slideshow slides={slides} qrSvg={qr} />;
}

/**
 * The latest slides, or none when the album can't be read: the slideshow then shows its empty
 * screen and asks again every 30 s, as it does when a refresh fails, rather than an error page.
 */
async function slidesOrNone() {
  try {
    return await loadSlides();
  } catch (error) {
    console.error("[slideshow] could not read the album:", describeError(error));
    return [];
  }
}

async function albumQr() {
  const url = await albumUrl();
  return qrSvg(url, "QR code to the shared album");
}
