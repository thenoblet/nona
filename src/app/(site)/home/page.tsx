import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple, schedule } from "@/content/wedding";
import { isSecondDay, resolveMode, type Mode } from "@/lib/mode";
import { Autoplay } from "@/components/music/Autoplay";
import { DockItem } from "@/components/music/Dock";
import { SharePill } from "@/components/layout/SharePill";
import { SiteHeader } from "@/components/home/SiteHeader";
import { HeroAfter, HeroBefore, HeroDay } from "@/components/home/Heroes";
import { Gallery, InvitationLetter, Story } from "@/components/home/Story";
import { Celebrations } from "@/components/home/Celebrations";
import { MapSection } from "@/components/home/MapSection";
import { AlbumTeaser, Colours, Faq, Footer, Gifts, Party, RsvpBand, Travel } from "@/components/home/Sections";
import { AfterAlbum, LiveAlbum, TodaySection, WishesWall } from "@/components/home/ModeSections";
import { dayLabel, nowIndex } from "@/components/today/ByDay";

export const metadata: Metadata = {
  title: "Our invitation",
};

/**
 * The homepage. The date picks one of three versions (see src/lib/mode.ts):
 * before the wedding, the wedding weekend, or after. Preview another version
 * with ?mode=day or ?mode=after (in development, or with ALLOW_MODE_PREVIEW=true).
 */
export default function HomePage({ searchParams }: PageProps<"/home">) {
  return (
    <>
      <Autoplay />
      <Suspense fallback={<HomeLoading />}>
        <Home searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Home({ searchParams }: { searchParams: PageProps<"/home">["searchParams"] }) {
  await connection();
  const params = await searchParams;
  const now = new Date();
  const mode: Mode = resolveMode(now, params.mode);
  const secondDay = mode === "day" && isSecondDay(now);
  const current = schedule[nowIndex(secondDay)];

  return (
    <>
      <SiteHeader mode={mode} />
      <main>
        {mode === "before" ? (
          <>
            <HeroBefore />
            <InvitationLetter />
            <Story />
            <Celebrations />
            <MapSection />
            <Colours />
            <Party />
            <Gallery />
            <Travel />
            <RsvpBand />
            <Gifts />
            <AlbumTeaser />
            <Faq />
          </>
        ) : null}

        {mode === "day" ? (
          <>
            <HeroDay todayLabel={dayLabel(secondDay)} nowTitle={current.title} nowPlace={current.place.replace(", Tepa", "")} />
            <LiveAlbum />
            <TodaySection todayLabel={dayLabel(secondDay)} secondDay={secondDay} />
            <Celebrations />
            <MapSection />
            <Story />
            <Party />
            <Gallery />
            <Gifts />
            <Faq />
            <DockItem>
              <SharePill />
            </DockItem>
          </>
        ) : null}

        {mode === "after" ? (
          <>
            <HeroAfter />
            <AfterAlbum />
            <WishesWall />
            <Story />
            <Party />
            <Gifts />
          </>
        ) : null}
      </main>
      <Footer />
    </>
  );
}

/** Shown for a moment while the server works out which version to send. */
function HomeLoading() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-4 bg-cocoa text-white">
      <span className="font-script text-6xl text-ember">{couple.monogram}</span>
      <span className="text-[11px] uppercase tracking-[0.3em] text-mist">{couple.tag}</span>
    </div>
  );
}
