import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple } from "@/content/wedding";
import { getSiteContent } from "@/lib/content/get";
import { scheduleItemPlace } from "@/lib/content/place";
import { liveStreamState, visibleFaq } from "@/lib/content/live";
import { getSiteImages } from "@/lib/site-images/get";
import { slotPhotos } from "@/lib/site-images/photos";
import { resolveMode, type Mode } from "@/lib/mode";
import { Autoplay } from "@/components/music/Autoplay";
import { DockItem } from "@/components/music/Dock";
import { SharePill } from "@/components/layout/SharePill";
import { SiteHeader } from "@/components/home/SiteHeader";
import { HeroAfter, HeroBefore, HeroDay } from "@/components/home/Heroes";
import { Gallery, InvitationLetter, Story } from "@/components/home/Story";
import { Celebrations } from "@/components/home/Celebrations";
import { MapSection } from "@/components/home/MapSection";
import { AlbumTeaser, Colours, Faq, Footer, Party, RsvpBand, Travel } from "@/components/home/Sections";
import { AfterAlbum, LiveAlbum, TodaySection, WishesWall } from "@/components/home/ModeSections";
import { currentItem, dayLabel } from "@/components/today/day";

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
  const [content, siteImages] = await Promise.all([getSiteContent(), getSiteImages()]);
  const { celebrations, schedule, venues, landmarks, story, party, travel, rsvp } = content;
  // The couple's photos where they replaced one (Site photos), the built-in ones elsewhere.
  const photos = slotPhotos(siteImages, party);
  const faq = visibleFaq(content);
  const params = await searchParams;
  // One moment for the whole page, so the version, the schedule and the live stream agree.
  const now = new Date();
  const live = liveStreamState(content, now);
  const mode: Mode = resolveMode(now, params.mode);
  const current = mode === "day" ? currentItem(schedule, celebrations, now) : undefined;
  const todayLabel = dayLabel(celebrations);

  return (
    <>
      <SiteHeader mode={mode} />
      <main>
        {mode === "before" ? (
          <>
            <HeroBefore photo={photos["home-hero"]} />
            <InvitationLetter rsvp={rsvp} band={photos["invitation-band"]} />
            <Story story={story} photos={photos} />
            <Celebrations celebrations={celebrations} venues={venues} />
            <MapSection venues={venues} landmarks={landmarks} />
            <Colours />
            <Party party={party} photos={photos} />
            <Gallery photos={photos} />
            <Travel travel={travel} />
            <RsvpBand rsvp={rsvp} />
            <AlbumTeaser />
            <Faq faq={faq} />
          </>
        ) : null}

        {mode === "day" ? (
          <>
            <HeroDay
              todayLabel={todayLabel}
              now={current ? { title: current.title, place: scheduleItemPlace(current, celebrations, venues).replace(", Tepa", "") } : null}
              photo={photos["home-hero"]}
            />
            <LiveAlbum now={now.getTime()} />
            <TodaySection
              todayLabel={todayLabel}
              schedule={schedule}
              celebrations={celebrations}
              venues={venues}
              now={now}
              liveUrl={live.show ? live.url : null}
            />
            <Celebrations celebrations={celebrations} venues={venues} />
            <MapSection venues={venues} landmarks={landmarks} />
            <Story story={story} photos={photos} />
            <Party party={party} photos={photos} />
            <Gallery photos={photos} />
            <Faq faq={faq} />
            <DockItem>
              <SharePill />
            </DockItem>
          </>
        ) : null}

        {mode === "after" ? (
          <>
            <HeroAfter />
            <AfterAlbum celebrations={celebrations} />
            <WishesWall />
            <Story story={story} photos={photos} />
            <Party party={party} photos={photos} />
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
