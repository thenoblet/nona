import { Suspense } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { wedding } from "@/content/wedding";
import { shareDefaults } from "@/lib/share";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow } from "@/components/ui/Typography";
import { getSiteContent } from "@/lib/content/get";
import { RsvpForm } from "@/components/rsvp/RsvpForm";

export const metadata: Metadata = {
  title: "RSVP",
  description: `We'd love to know if you can celebrate with us. Please reply by ${wedding.rsvpBy}; it only takes a minute.`,
  openGraph: {
    ...shareDefaults,
    title: "Kindly respond · Noblet & Nancy",
    description: `We'd love to know if you can celebrate with us. Please reply by ${wedding.rsvpBy}; it only takes a minute.`,
    url: "/rsvp",
  },
};

export default function RsvpPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <PhoneHeader>
        <div className="mt-5 flex flex-col gap-2.5">
          <Eyebrow tone="ember">Répondez s&apos;il vous plaît</Eyebrow>
          <h1 className="font-script text-[56px] leading-[1.1] font-normal sm:text-[64px]">Kindly respond</h1>
          <p className="text-[15px] leading-[1.65] font-light text-mist">
            We&apos;d love to know if you can celebrate with us. It only takes a minute.
          </p>
          <p className="mt-1.5 inline-flex items-center gap-2.5 self-start rounded-full border border-ember/50 py-1.5 pr-4 pl-1.5 text-[13px] text-linen">
            <span className="flex size-7.5 items-center justify-center rounded-full bg-white/10 text-ember">
              <Icon name="calendar" size={15} />
            </span>
            Please reply by {wedding.rsvpBy}
          </p>
        </div>
      </PhoneHeader>
      <Suspense fallback={<FormSkeleton />}>
        <RsvpFormLoader />
      </Suspense>
    </main>
  );
}

/** Read at request time, so celebrations edited in the admin show up without a rebuild. */
async function RsvpFormLoader() {
  await connection();
  const { celebrations } = await getSiteContent();
  const siteUrl = (process.env.SITE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return <RsvpForm celebrations={celebrations} siteUrl={siteUrl} />;
}

function FormSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the reply form" className="mx-auto flex w-full max-w-xl flex-col gap-5 px-5 py-8 sm:px-8">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-13 animate-pulse rounded-full bg-blush" />
      ))}
    </div>
  );
}
