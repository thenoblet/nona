import type { Metadata } from "next";
import { connection } from "next/server";
import { cache, Suspense, type ReactNode } from "react";
import { wedding } from "@/content/wedding";
import { SiteHeader } from "@/components/home/SiteHeader";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { ProgrammeCelebration, longDate } from "@/components/programme/ProgrammeCelebration";
import { ProgrammeIndex } from "@/components/programme/ProgrammeIndex";
import { inProgrammeOrder, notStarted, programmeNow } from "@/components/today/day";
import { PillAnchor } from "@/components/ui/Button";
import { Motto } from "@/components/ui/Typography";
import { getSiteContent } from "@/lib/content/get";
import { getSiteImages } from "@/lib/site-images/get";
import { slotPhotos } from "@/lib/site-images/photos";
import { HOST_SLOT_ID } from "@/lib/site-images/slots";
import type { Celebration } from "@/lib/content/schema";
import { resolveMode } from "@/lib/mode";

export const metadata: Metadata = {
  title: "Order of the day",
  description: "Every part of Noblet and Nancy's wedding day in Tepa, from the first hymn to the last dance.",
};

/** "Sat 5 December · Tepa", from the first and last celebrations' dates: one day, as Saturday's two share it. */
function weekendLine(celebrations: Celebration[]): string {
  const first = celebrations[0];
  const last = celebrations.at(-1);
  if (!first || !last) return wedding.town;
  const firstDay = `${first.weekdayShort} ${Number(first.day)}`;
  const lastDay = `${last.weekdayShort} ${Number(last.day)} ${last.month}`;
  const days = first.date === last.date ? lastDay : first.month === last.month ? `${firstDay} & ${lastDay}` : `${firstDay} ${first.month} & ${lastDay}`;
  return `${days} · ${wedding.town}`;
}

/** Read once per request and shared by every streamed piece, so they agree on the moment and the mode. */
const loadProgramme = cache(async (searchParams: PageProps<"/programme">["searchParams"]) => {
  await connection();
  const [content, siteImages] = await Promise.all([getSiteContent(), getSiteImages()]);
  const now = new Date();
  const mode = resolveMode(now, (await searchParams).mode);
  const programme = inProgrammeOrder(content.schedule);
  const standing = mode === "day" ? programmeNow(programme, content.celebrations, now) : notStarted;
  // The MC hosts the reception: "Hosted by" with his photo from Site photos, unless he is hidden.
  const host = content.host.hidden ? null : { name: content.host.name, photo: slotPhotos(siteImages, [])[HOST_SLOT_ID] ?? null };
  return { ...content, mode, programme, standing, receptionHost: host };
});

type Loaded = Awaited<ReturnType<typeof loadProgramme>>;
type Searched = { searchParams: PageProps<"/programme">["searchParams"] };

/** Renders a piece from the content read at request time, behind a placeholder that reads none. */
async function AtRequest({ searchParams, render }: Searched & { render: (loaded: Loaded) => ReactNode }) {
  return render(await loadProgramme(searchParams));
}

/**
 * The whole order of the day, celebration by celebration. The title, headers and footer are static;
 * the programme is read at request time, so the couple's edits show at once and, on the wedding
 * weekend, the item on now is marked by the clock.
 */
export default function ProgrammePage({ searchParams }: PageProps<"/programme">) {
  return (
    <main id="top" className="min-h-dvh bg-white">
      <div className="hidden lg:contents">
        <Suspense fallback={<div className="h-[78px] border-b border-ember/35 bg-cocoa" />}>
          <AtRequest searchParams={searchParams} render={({ mode }) => <SiteHeader mode={mode} current="/programme" />} />
        </Suspense>
      </div>
      <PhoneHeader className="lg:hidden" />

      <section className="bg-cocoa px-5 pb-9 text-center text-white lg:px-10 lg:pt-14 lg:pb-15">
        <div className="mx-auto flex max-w-xl flex-col items-center gap-2 lg:max-w-3xl lg:gap-2.5">
          <p className="m-0 min-h-[1lh] text-[11px] uppercase tracking-[0.26em] text-ember lg:tracking-[0.28em]">
            <Suspense fallback={null}>
              <AtRequest searchParams={searchParams} render={({ celebrations }) => weekendLine(celebrations)} />
            </Suspense>
          </p>
          <h1 className="m-0 font-script text-[54px] leading-[1.1] font-normal lg:text-[84px] lg:leading-[1.05]">Order of the day</h1>
          <p className="m-0 max-w-[30ch] font-serif text-[19px] leading-[1.45] text-linen italic lg:max-w-none lg:text-[22px]">
            Every part of each celebration, from the first hymn to the last dance.
          </p>
        </div>
      </section>

      <Suspense fallback={<ProgrammeSkeleton />}>
        <AtRequest searchParams={searchParams} render={(loaded) => <Programme {...loaded} />} />
      </Suspense>

      <footer className="mt-10 flex flex-col items-center gap-3.5 bg-tray px-5 pt-7.5 pb-28 text-center lg:mt-16">
        <p className="m-0 font-serif text-[19px] text-mocha italic">Times may move a little on the day.</p>
        <PillAnchor href="#top" variant="cocoa">
          Back to the top
        </PillAnchor>
        <Motto className="text-[30px] text-ember" />
      </footer>
    </main>
  );
}

/** The index and every celebration's timeline. */
function Programme({ celebrations, venues, programme, standing, receptionHost }: Loaded) {
  const entries = celebrations.map((celebration) => ({ id: celebration.id, name: celebration.name, when: longDate(celebration) }));
  return (
    <>
      <ProgrammeIndex entries={entries} layout="chips" />
      <div className="mx-auto max-w-[1060px] px-5 pt-7.5 lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-16 lg:px-10 lg:pt-14">
        <aside className="hidden self-stretch lg:block">
          <ProgrammeIndex entries={entries} layout="card" />
        </aside>
        <div className="flex flex-col gap-10 lg:gap-11">
          {celebrations.map((celebration) => (
            <ProgrammeCelebration
              key={celebration.id}
              celebration={celebration}
              venues={venues}
              items={programme.flatMap((item, index) => (item.celebration === celebration.id ? [{ item, index }] : []))}
              standing={standing}
              host={celebration.id === "reception" ? receptionHost : null}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function ProgrammeSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the order of the day" className="mx-auto flex max-w-[1060px] flex-col gap-3 px-5 pt-20 lg:px-10 lg:pt-14 lg:pl-[384px]">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div key={row} className="h-12 animate-pulse rounded-[var(--radius-paper)] bg-blush" />
      ))}
    </div>
  );
}
