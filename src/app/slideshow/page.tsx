import type { Metadata } from "next";
import { Suspense } from "react";
import { albumUrl, qrSvg } from "@/lib/qr";
import { PauseMusic } from "@/components/slideshow/PauseMusic";
import { Slideshow } from "@/components/slideshow/Slideshow";
import { loadSlides } from "./slides";

export const metadata: Metadata = {
  title: "Slideshow",
  robots: { index: false },
};

/**
 * Guests' newest photos. Landscape screens (the venue TV, laptops, a phone on its side) get
 * the TV layout with a QR code to the album; portrait phones get the photo full screen.
 * The layout is chosen in CSS (the `tv` variant in globals.css), never from the user agent.
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
  const [slides, qr] = await Promise.all([loadSlides(), albumQr()]);
  return <Slideshow slides={slides} qrSvg={qr} />;
}

async function albumQr() {
  const url = await albumUrl();
  return qrSvg(url, "QR code to the shared album");
}
