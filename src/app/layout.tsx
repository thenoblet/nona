import type { Metadata, Viewport } from "next";
import { cormorant, jost, pinyon } from "./fonts";
import { MusicProvider } from "@/components/music/MusicProvider";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "http://localhost:3000"),
  title: {
    default: "Noblet & Nancy · NONA'26",
    template: "%s · Noblet & Nancy",
  },
  description:
    "Together with their families, Noblet and Nancy invite you to celebrate the beginning of their forever. Saturday, 5 December 2026 · Tepa, Ashanti.",
  openGraph: {
    title: "Noblet & Nancy · NONA'26",
    description: "Saturday, 5 December 2026 · Tepa, Ashanti. Kindly reply by 23 November.",
    images: ["/images/story/embrace-bw.jpg"],
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#3D2927",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${cormorant.variable} ${jost.variable} ${pinyon.variable} antialiased`}>
      <body className="min-h-dvh bg-white text-cocoa">
        {/* Music lives here so it keeps playing from the landing page into the site. */}
        <MusicProvider>{children}</MusicProvider>
      </body>
    </html>
  );
}
