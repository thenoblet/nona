import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { cormorant, jost, pinyon } from "./fonts";
import { MusicProvider } from "@/components/music/MusicProvider";
import { invitationOpenGraph } from "@/lib/invitation-preview";
import { siteUrl } from "@/lib/site-url";
import "./globals.css";

/**
 * Read at request time, so the reply-by date set in the admin, or replies being closed, reach link
 * previews without a rebuild (the build has no database). Browsers get the tags streamed in after the page's static
 * shell; link-preview bots (WhatsApp, Facebook, X) still get them in the <head>. The same goes for the
 * invitation card's photo: once the couple change it in the admin and the worker has drawn the card,
 * og:image is that card (on MEDIA_BASE_URL); until then, opengraph-image.tsx's build-time one.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return {
    metadataBase: new URL(siteUrl()),
    title: {
      default: "Noblet & Nancy · NONA'26",
      template: "%s · Noblet & Nancy",
    },
    description:
      "Together with their families, Noblet and Nancy invite you to celebrate the beginning of their forever. Saturday, 5 December 2026 · Tepa, Ashanti.",
    // The invitation card: the one the worker drew, or opengraph-image.tsx's (src/lib/invitation-preview.ts).
    openGraph: await invitationOpenGraph(),
    twitter: { card: "summary_large_image" },
  };
}

export const viewport: Viewport = {
  themeColor: "#3D2927",
  width: "device-width",
  initialScale: 1,
  // The page reaches the screen's edges, so the phone tab bar sits on the home bar's strip; what
  // has to stay clear of the notch and the home bar uses the safe-area insets.
  viewportFit: "cover",
};

/**
 * Renders nothing. Every page's metadata is read at request time (above), and the build refuses
 * that on a page that is otherwise static unless the page also says it renders at request time.
 */
async function RequestTime() {
  await connection();
  return null;
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-scroll-behavior: in-page links glide, but a new page starts at the top straight away.
    <html lang="en" data-scroll-behavior="smooth" className={`${cormorant.variable} ${jost.variable} ${pinyon.variable} antialiased`}>
      {/* Browser extensions (Grammarly, password managers) add attributes to <body> before React loads. */}
      <body className="min-h-dvh bg-white text-cocoa" suppressHydrationWarning>
        {/* Music lives here so it keeps playing from the landing page into the site. */}
        <MusicProvider>{children}</MusicProvider>
        <Suspense>
          <RequestTime />
        </Suspense>
      </body>
    </html>
  );
}
