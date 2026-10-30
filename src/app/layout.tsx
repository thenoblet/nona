import type { Metadata, Viewport } from "next";
import { cormorant, jost, pinyon } from "./fonts";
import { MusicProvider } from "@/components/music/MusicProvider";
import { wedding } from "@/content/wedding";
import { shareDefaults } from "@/lib/share";
import { siteUrl } from "@/lib/site-url";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Noblet & Nancy · NONA'26",
    template: "%s · Noblet & Nancy",
  },
  description:
    "Together with their families, Noblet and Nancy invite you to celebrate the beginning of their forever. Saturday, 5 December 2026 · Tepa, Ashanti.",
  // The preview image is the invitation card in opengraph-image.tsx.
  openGraph: {
    ...shareDefaults,
    title: "Noblet & Nancy · 5 December 2026",
    description: `Together with their families, they invite you to celebrate the beginning of their forever. Tepa, Ashanti. Kindly reply by ${wedding.rsvpBy}.`,
    url: "/",
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#3D2927",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-scroll-behavior: in-page links glide, but a new page starts at the top straight away.
    <html lang="en" data-scroll-behavior="smooth" className={`${cormorant.variable} ${jost.variable} ${pinyon.variable} antialiased`}>
      {/* Browser extensions (Grammarly, password managers) add attributes to <body> before React loads. */}
      <body className="min-h-dvh bg-white text-cocoa" suppressHydrationWarning>
        {/* Music lives here so it keeps playing from the landing page into the site. */}
        <MusicProvider>{children}</MusicProvider>
      </body>
    </html>
  );
}
