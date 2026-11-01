import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { connection } from "next/server";
import { accraDayAndFullMonth } from "@/lib/accra";
import { shareDefaults } from "@/lib/share";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { Icon } from "@/components/ui/Icon";
import { Eyebrow } from "@/components/ui/Typography";
import { getSiteContent } from "@/lib/content/get";
import { getSiteImages, storedCardImages } from "@/lib/site-images/get";
import { siteUrl } from "@/lib/site-url";
import { RepliesClosed } from "@/components/rsvp/RepliesClosed";
import { RsvpForm } from "@/components/rsvp/RsvpForm";

/**
 * Read at request time, so the reply-by date, or replies being closed, reach link previews without a
 * rebuild, and so does the card's photo once the couple change it (the worker's card on og:image).
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const [{ rsvp }, siteImages] = await Promise.all([getSiteContent(), getSiteImages()]);
  const description = rsvp.open
    ? `We'd love to know if you can celebrate with us. Please reply by ${accraDayAndFullMonth(rsvp.replyBy)}; it only takes a minute.`
    : "Replies have closed.";
  return {
    title: "RSVP",
    description,
    openGraph: {
      ...shareDefaults,
      title: "Kindly respond · Noblet & Nancy",
      description,
      url: "/rsvp",
      ...storedCardImages(siteImages, "rsvp"),
    },
  };
}

export default function RsvpPage() {
  return (
    <main className="flex min-h-dvh flex-col bg-white">
      <PhoneHeader>
        <div className="mt-5 flex flex-col gap-2.5">
          <Eyebrow tone="ember">Répondez s&apos;il vous plaît</Eyebrow>
          <h1 className="font-script text-[56px] leading-[1.1] font-normal sm:text-[64px]">Kindly respond</h1>
          <Suspense fallback={<Invitation />}>
            <InvitationLoader />
          </Suspense>
        </div>
      </PhoneHeader>
      <Suspense fallback={<FormSkeleton />}>
        <RsvpFormLoader />
      </Suspense>
    </main>
  );
}

/**
 * Read at request time, so celebrations edited in the admin, and replies closed there, show up
 * without a rebuild. While replies are closed, the closed message takes the form's place.
 */
async function RsvpFormLoader() {
  await connection();
  const { celebrations, venues, rsvp } = await getSiteContent();
  if (!rsvp.open) return <RepliesClosed message={rsvp.closedMessage} />;
  return <RsvpForm celebrations={celebrations} venues={venues} siteUrl={siteUrl()} />;
}

async function InvitationLoader() {
  await connection();
  const { rsvp } = await getSiteContent();
  if (!rsvp.open) return <DatePill>Replies have closed</DatePill>;
  return <Invitation replyBy={accraDayAndFullMonth(rsvp.replyBy)} />;
}

/** The line under the title and the reply-by date. Without a date, it holds the date's place while it loads. */
function Invitation({ replyBy }: { replyBy?: string }) {
  return (
    <>
      <p className="text-[15px] leading-[1.65] font-light text-mist">
        We&apos;d love to know if you can celebrate with us. It only takes a minute.
      </p>
      <DatePill>
        {replyBy ? `Please reply by ${replyBy}` : <span className="block h-4 w-36 animate-pulse rounded-full bg-white/10" />}
      </DatePill>
    </>
  );
}

function DatePill({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 inline-flex items-center gap-2.5 self-start rounded-full border border-ember/50 py-1.5 pr-4 pl-1.5 text-[13px] text-linen">
      <span className="flex size-7.5 items-center justify-center rounded-full bg-white/10 text-ember">
        <Icon name="calendar" size={15} />
      </span>
      {children}
    </p>
  );
}

function FormSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the reply form" className="mx-auto flex w-full max-w-xl flex-col gap-5 px-5 py-8 sm:px-8">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="h-13 animate-pulse rounded-full bg-blush" />
      ))}
    </div>
  );
}
