import type { Metadata } from "next";
import Link from "next/link";
import { couple } from "@/content/wedding";
import { PillLink } from "@/components/ui/Button";
import { Motto } from "@/components/ui/Typography";
import { SharePill } from "@/components/layout/SharePill";
import { DockItem } from "@/components/music/Dock";
import type { SiteContent } from "@/lib/content/schema";
import { ByDay, dayLabel } from "@/components/today/ByDay";
import { HappeningNow } from "@/components/today/HappeningNow";
import { OrderOfDay } from "@/components/today/OrderOfDay";
import { QuickActions } from "@/components/today/QuickActions";
import { SeatFinder } from "@/components/today/SeatFinder";

export const metadata: Metadata = { title: "Today" };

const column = "mx-auto w-full max-w-xl sm:px-8";

/**
 * The wedding-day screen: what's on now, your seat, and sharing photos. The times and places are
 * read once at request time (see ByDay); the prerendered shell is a skeleton that reads no content.
 */
export default function TodayPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <ByDay fallback={<TodaySkeleton />} render={(secondDay, content) => <TodayBody secondDay={secondDay} content={content} />} />
      <DockItem>
        <SharePill />
      </DockItem>
    </main>
  );
}

function TodayBody({ secondDay, content }: { secondDay: boolean; content: SiteContent }) {
  return (
    <>
      <header className="bg-cocoa text-white">
        <div className={`${column} flex flex-col gap-4 px-5 pt-5 pb-8`}>
          <div className="flex min-h-11 items-center justify-between">
            <Link href="/home" aria-label="Home" className="font-script text-3xl text-ember no-underline">
              {couple.monogram}
            </Link>
            <span className="text-[11px] uppercase tracking-[0.24em] text-mist">
              {dayLabel(secondDay, content.celebrations)}
            </span>
          </div>
          <h1 className="font-script text-[58px] leading-[1.05] font-normal sm:text-[64px]">Today&apos;s the day</h1>
          <p className="-mt-1.5 font-serif text-xl text-linen italic">Thank you for being here with us.</p>
          <HappeningNow schedule={content.schedule} secondDay={secondDay} />
          <PillLink href="/album" variant="ember" icon="camera" size="lg" block className="justify-start!">
            Share photos &amp; videos
          </PillLink>
        </div>
      </header>

      <section aria-labelledby="seat-h" className="bg-tray">
        <div className={`${column} px-4 py-7`}>
          <SeatFinder />
        </div>
      </section>

      <section aria-labelledby="sched-h" className={`${column} px-5 pt-8 pb-3`}>
        <h2 id="sched-h" className="mb-3 font-serif text-[30px] italic">
          Order of the day
        </h2>
        <OrderOfDay schedule={content.schedule} secondDay={secondDay} />
      </section>

      <div className="mt-5 bg-tray pb-28">
        <section aria-label="Quick actions" className={`${column} px-4 pt-6 pb-8`}>
          <QuickActions reception={content.venues.reception} />
        </section>
        <p className="pt-7 text-center">
          <Motto className="text-[30px] text-ember" />
        </p>
      </div>
    </>
  );
}

/** Shown while the server reads the day's times. Reads no content. */
function TodaySkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading today's plans">
      <header className="bg-cocoa text-white">
        <div className={`${column} flex flex-col gap-4 px-5 pt-5 pb-8`}>
          <div className="flex min-h-11 items-center">
            <span className="font-script text-3xl text-ember">{couple.monogram}</span>
          </div>
          <h1 className="font-script text-[58px] leading-[1.05] font-normal sm:text-[64px]">Today&apos;s the day</h1>
          <div className="h-16 animate-pulse rounded-full bg-white/10" />
        </div>
      </header>
      <div className={`${column} flex flex-col gap-4 px-5 py-8`}>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="h-14 animate-pulse rounded-[var(--radius-paper)] bg-blush" />
        ))}
      </div>
    </div>
  );
}
