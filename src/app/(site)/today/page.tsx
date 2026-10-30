import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { couple } from "@/content/wedding";
import { PillLink } from "@/components/ui/Button";
import { Motto } from "@/components/ui/Typography";
import { SharePill } from "@/components/layout/SharePill";
import { DockItem } from "@/components/music/Dock";
import { ByDay } from "@/components/today/ByDay";
import { dayLabel } from "@/components/today/day";
import { HappeningNow } from "@/components/today/HappeningNow";
import { OrderOfDay } from "@/components/today/OrderOfDay";
import { liveStreamState } from "@/lib/content/live";
import { QuickActions } from "@/components/today/QuickActions";

export const metadata: Metadata = { title: "Today" };

const column = "mx-auto w-full max-w-xl sm:px-8";

/**
 * The wedding-day screen: what's on now and sharing photos. The header, buttons and
 * headings are static; only the pieces that read the day's times are streamed in at request time
 * (see ByDay), each behind a placeholder that reads no content.
 */
export default function TodayPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <TodayLayout
        dayLabel={<ByDay fallback={<span className="inline-block h-3 w-24 animate-pulse rounded-full bg-white/10" />} render={(secondDay, content) => dayLabel(secondDay, content.celebrations)} />}
        happeningNow={
          <ByDay
            fallback={<div className="h-16 animate-pulse rounded-full bg-white/10" />}
            render={(secondDay, content) => <HappeningNow schedule={content.schedule} secondDay={secondDay} />}
          />
        }
        orderOfDay={
          <ByDay
            fallback={<OrderSkeleton />}
            render={(secondDay, content) => <OrderOfDay schedule={content.schedule} secondDay={secondDay} />}
          />
        }
        quickActions={
          <ByDay
            fallback={<div className="h-56 animate-pulse rounded-[var(--radius-paper)] bg-white" />}
            render={(_secondDay, content) => {
              const live = liveStreamState(content, new Date());
              return <QuickActions reception={content.venues.reception} liveUrl={live.show ? live.url : null} />;
            }}
          />
        }
      />
      <DockItem>
        <SharePill />
      </DockItem>
    </main>
  );
}

type TodaySlots = {
  dayLabel: ReactNode;
  happeningNow: ReactNode;
  orderOfDay: ReactNode;
  quickActions: ReactNode;
};

/** The page's static chrome, with a slot for each piece that depends on the schedule. */
function TodayLayout({ dayLabel: dayLabelSlot, happeningNow, orderOfDay, quickActions }: TodaySlots) {
  return (
    <>
      <header className="bg-cocoa text-white">
        <div className={`${column} flex flex-col gap-4 px-5 pt-5 pb-8`}>
          <div className="flex min-h-11 items-center justify-between">
            <Link href="/home" aria-label="Home" className="font-script text-3xl text-ember no-underline">
              {couple.monogram}
            </Link>
            <span className="text-[11px] uppercase tracking-[0.24em] text-mist">{dayLabelSlot}</span>
          </div>
          <h1 className="font-script text-[58px] leading-[1.05] font-normal sm:text-[64px]">Today&apos;s the day</h1>
          <p className="-mt-1.5 font-serif text-xl text-linen italic">Thank you for being here with us.</p>
          {happeningNow}
          <PillLink href="/album" variant="ember" icon="camera" size="lg" block className="justify-start!">
            Share photos &amp; videos
          </PillLink>
        </div>
      </header>

      <section aria-labelledby="sched-h" className={`${column} px-5 pt-8 pb-3`}>
        <h2 id="sched-h" className="mb-3 font-serif text-[30px] italic">
          Order of the day
        </h2>
        {orderOfDay}
      </section>

      <div className="mt-5 bg-tray pb-28">
        <section aria-label="Quick actions" className={`${column} px-4 pt-6 pb-8`}>
          {quickActions}
        </section>
        <p className="pt-7 text-center">
          <Motto className="text-[30px] text-ember" />
        </p>
      </div>
    </>
  );
}

function OrderSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the order of the day" className="flex flex-col gap-3 border-t border-hairline pt-4">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-14 animate-pulse rounded-[var(--radius-paper)] bg-blush" />
      ))}
    </div>
  );
}
