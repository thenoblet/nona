import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple, wedding } from "@/content/wedding";
import { getSiteImages } from "@/lib/site-images/get";
import { resolveSlotPhoto } from "@/lib/site-images/photos";
import { slotDefinition } from "@/lib/site-images/slots";
import { OpenInvitation } from "@/components/landing/OpenInvitation";
import { SitePhoto } from "@/components/ui/SitePhoto";

const printPhoto = "block h-[180px] w-full object-cover sm:h-[230px] lg:h-[290px]";

/**
 * The cover and the print, read at request time, so a photo the couple replace in the admin shows
 * without a rebuild (the build has no database). Each waits in its box while it streams in: no
 * built-in photo is fetched only to be swapped out.
 */
async function LandingPhoto({ slotId }: { slotId: "landing-cover" | "landing-print" }) {
  await connection();
  const slot = slotDefinition(slotId);
  const photo = slot ? resolveSlotPhoto(slot, (await getSiteImages())[slotId]) : null;
  if (!photo) return null;
  if (slotId === "landing-print") return <SitePhoto photo={photo} sizes="230px" className={printPhoto} />;
  return <SitePhoto photo={photo} fill priority blur sizes="(min-width: 1024px) 47vw, 100vw" className="object-cover" />;
}

/**
 * The landing page: an editorial cover. Phones get the photo on top and the
 * names below; from lg the photo runs full height down the left.
 */
export default function Landing() {
  return (
    <main className="min-h-dvh bg-white text-cocoa lg:grid lg:grid-cols-[minmax(0,47%)_minmax(0,1fr)]">
      <div className="relative lg:sticky lg:top-0 lg:h-dvh">
        <div className="relative aspect-[4/5] w-full bg-tile sm:aspect-[16/11] lg:aspect-auto lg:h-full">
          <Suspense>
            <LandingPhoto slotId="landing-cover" />
          </Suspense>
          <p className="absolute bottom-5 left-5 m-0 max-w-[45%] text-[11px] leading-relaxed uppercase tracking-[0.3em] text-white sm:bottom-9 sm:left-10 sm:max-w-none sm:text-xs">
            The proposal · 7 June 2026
          </p>
          <nav
            aria-label="Main"
            className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/45 to-transparent px-5 pt-4 pb-10 text-[11px] uppercase tracking-[0.24em] text-white sm:px-10 lg:hidden"
          >
            <span className="font-medium">{couple.tag}</span>
            <Link href="/rsvp" className="ember-link inline-flex min-h-11 items-center no-underline">
              RSVP
            </Link>
          </nav>
        </div>
        <div
          className="print absolute right-5 -bottom-20 w-[150px] animate-rise bg-white p-2 pb-8 shadow-[0_18px_40px_rgb(61_41_39/0.22)] sm:right-12 sm:w-[190px] lg:top-[58%] lg:-right-20 lg:bottom-auto lg:w-[230px] lg:p-2.5 lg:pb-10"
          style={{ transform: "rotate(-4deg)", animationDelay: "500ms" }}
        >
          <Suspense fallback={<div className={`${printPhoto} bg-tile`} />}>
            <LandingPhoto slotId="landing-print" />
          </Suspense>
          <p className="absolute inset-x-0 bottom-1.5 m-0 text-center font-script text-xl sm:text-2xl">she said yes</p>
        </div>
      </div>

      <div className="flex flex-col px-5 pb-16 sm:px-10 lg:px-0 lg:pr-18 lg:pb-14 lg:pl-20">
        <nav
          aria-label="Main"
          className="order-first hidden h-24 items-center justify-between border-b border-hairline text-xs uppercase tracking-[0.24em] lg:flex"
        >
          <span className="font-medium">{couple.tag}</span>
          <div className="flex items-center gap-7">
            <Link href="/home#story" className="py-3 no-underline">Story</Link>
            <Link href="/home#celebrations" className="py-3 no-underline">Celebrations</Link>
            <Link href="/album" className="py-3 no-underline">Album</Link>
            <Link href="/rsvp" className="ember-link py-3 no-underline">RSVP</Link>
          </div>
        </nav>

        <div className="mt-28 flex flex-col sm:mt-30 lg:mt-14">
          <p className="m-0 mb-4 animate-rise text-[11px] uppercase tracking-[0.34em] text-mocha sm:text-xs">
            Issue No. 1 · A wedding
          </p>
          <h1 className="m-0 font-serif font-light">
            <span className="block animate-rise text-[88px] leading-[0.88] tracking-[-0.02em] sm:text-[120px] lg:text-[clamp(110px,10.4vw,150px)]" style={{ animationDelay: "150ms" }}>
              {couple.groom}
            </span>
            <span
              className="mt-1.5 ml-14 block animate-rise text-[88px] leading-[0.88] tracking-[-0.02em] italic sm:ml-24 sm:text-[120px] lg:ml-30 lg:text-[clamp(110px,10.4vw,150px)]"
              style={{ animationDelay: "300ms" }}
            >
              <span className="text-ember">&amp;</span> {couple.bride}
            </span>
          </h1>
        </div>

        <div className="mt-10 flex max-w-[480px] animate-rise flex-col gap-6.5 lg:mt-12 lg:ml-30" style={{ animationDelay: "500ms" }}>
          <p className="m-0 font-serif text-[22px] leading-[1.45] text-mocha sm:text-[26px]">
            Together with their families, they invite you to celebrate the beginning of their forever.
          </p>
          <div className="grid grid-cols-2 border-t border-b border-t-cocoa border-b-hairline">
            <div className="flex flex-col gap-1 border-r border-hairline py-4">
              <span className="text-[11px] uppercase tracking-[0.26em] text-mocha">When</span>
              <span className="font-serif text-[22px] font-medium sm:text-2xl">{wedding.dateShort}</span>
            </div>
            <div className="flex flex-col gap-1 py-4 pl-5">
              <span className="text-[11px] uppercase tracking-[0.26em] text-mocha">Where</span>
              <span className="font-serif text-[22px] font-medium sm:text-2xl">
                {wedding.town}, {wedding.region}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-5">
            <OpenInvitation />
            <Link
              href="/rsvp"
              className="ember-link inline-flex min-h-12 items-center text-xs uppercase tracking-[0.2em] no-underline"
            >
              Kindly respond
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
