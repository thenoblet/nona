import type { Metadata } from "next";
import { connection } from "next/server";
import { cache, Suspense, type ReactNode } from "react";
import { SiteHeader } from "@/components/home/SiteHeader";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { StayCard } from "@/components/stay/StayCard";
import { Icon } from "@/components/ui/Icon";
import { PillLink } from "@/components/ui/Button";
import { Motto } from "@/components/ui/Typography";
import { getSiteContent } from "@/lib/content/get";
import { resolveMode } from "@/lib/mode";

export const metadata: Metadata = {
  title: "Where to stay",
  description: "Places to stay close to the church in Tepa for Noblet and Nancy's wedding weekend.",
};

/** Read once per request and shared by the streamed pieces. */
const loadStays = cache(async (searchParams: PageProps<"/stay">["searchParams"]) => {
  await connection();
  const content = await getSiteContent();
  return { stays: content.stays, mode: resolveMode(new Date(), (await searchParams).mode) };
});

type Loaded = Awaited<ReturnType<typeof loadStays>>;

/** Renders a piece from the content read at request time, behind a placeholder that reads none. */
async function AtRequest({ searchParams, render }: { searchParams: PageProps<"/stay">["searchParams"]; render: (loaded: Loaded) => ReactNode }) {
  return render(await loadStays(searchParams));
}

/**
 * The places to stay for the wedding weekend, each with Call and Directions. The title and footer
 * are static; the places are read at request time, so a number the couple change shows at once.
 */
export default function StayPage({ searchParams }: PageProps<"/stay">) {
  return (
    <main className="min-h-dvh bg-white">
      <div className="hidden lg:contents">
        <Suspense fallback={<div className="h-[78px] border-b border-ember/35 bg-cocoa" />}>
          <AtRequest searchParams={searchParams} render={({ mode }) => <SiteHeader mode={mode} current="/stay" />} />
        </Suspense>
      </div>
      <PhoneHeader className="lg:hidden" />

      <section className="bg-cocoa px-5 pb-9 text-center text-white lg:px-10 lg:pt-12 lg:pb-14">
        <div className="mx-auto flex max-w-xl flex-col items-center gap-2 lg:max-w-3xl lg:gap-2.5">
          <p className="m-0 text-[11px] uppercase tracking-[0.26em] text-ember lg:tracking-[0.28em]">For our travelling guests · Tepa</p>
          <h1 className="m-0 font-script text-[54px] leading-[1.1] font-normal lg:text-[84px] lg:leading-[1.05]">Where to stay</h1>
          <p className="m-0 max-w-[30ch] font-serif text-[19px] leading-[1.45] text-linen italic lg:max-w-none lg:text-[22px]">
            A few places close to the church, for the wedding weekend.
          </p>
        </div>
      </section>

      <div className="mx-auto max-w-[1160px] px-5 pt-5.5 lg:px-10 lg:pt-10">
        <p className="m-0 mx-auto flex max-w-[820px] items-start gap-3 rounded-md bg-blush px-4 py-3.5 text-sm leading-normal text-mocha">
          <Icon name="bed" size={20} strokeWidth={1.7} className="mt-px shrink-0 text-ember" />
          <span>
            Call the hotel to book a room. <strong className="font-medium text-cocoa">Book early</strong>: Tepa has only a few places, and
            they go quickly on a wedding weekend.
          </span>
        </p>
        <Suspense fallback={<StaysSkeleton />}>
          <AtRequest
            searchParams={searchParams}
            render={({ stays }) => (
              <div className="mt-5.5 grid gap-4.5 sm:grid-cols-2 lg:mt-7.5 lg:grid-cols-3 lg:gap-6.5">
                {stays.map((stay) => (
                  <StayCard key={stay.name} stay={stay} />
                ))}
              </div>
            )}
          />
        </Suspense>
      </div>

      <footer className="mt-10 bg-tray px-5 pt-7.5 pb-28 lg:mt-14 lg:px-10 lg:py-9">
        <div className="mx-auto flex max-w-[1080px] flex-col items-center gap-3.5 text-center lg:flex-row lg:justify-between lg:text-left">
          <p className="m-0 max-w-[28ch] font-serif text-[19px] leading-[1.4] text-mocha italic lg:max-w-none lg:text-[21px]">
            Need help finding a room? Message Noblet or Nancy.
          </p>
          <div className="flex flex-col items-center gap-3.5 lg:flex-row lg:gap-6.5">
            <PillLink href="/programme" variant="cocoa">
              See the order of the day
            </PillLink>
            <Motto className="text-[28px] text-ember" />
          </div>
        </div>
      </footer>
    </main>
  );
}

function StaysSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the places to stay" className="mt-5.5 grid gap-4.5 sm:grid-cols-2 lg:mt-7.5 lg:grid-cols-3 lg:gap-6.5">
      {[0, 1, 2].map((card) => (
        <div key={card} className="h-[300px] animate-pulse rounded-md bg-blush" />
      ))}
    </div>
  );
}
