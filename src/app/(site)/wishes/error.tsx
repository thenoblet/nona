"use client";

import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { PillButton } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
import { Eyebrow } from "@/components/ui/Typography";

/**
 * Shown in place of the wishes page when the wall can't be read (the database is out of reach), in
 * the page's own look rather than the default error screen. Try again re-renders the page.
 */
export default function WishesError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="min-h-dvh bg-white pb-28">
      <PhoneHeader tone="light" backHref="/album" backText="Album">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <Eyebrow className="mt-1.5">Our guestbook</Eyebrow>
          <h1 className="m-0 font-script text-[56px] leading-[1.1] font-normal sm:text-[64px]">Leave us a wish</h1>
        </div>
      </PhoneHeader>

      <section role="alert" className="mx-auto flex max-w-xl flex-col items-center gap-5 px-4.5 pt-12 text-center sm:px-8">
        <Halo icon="heart" size="lg" />
        <p className="m-0 font-serif text-xl leading-relaxed text-mocha">
          The wishes wall can&apos;t load right now. Try again in a minute.
        </p>
        <PillButton variant="cocoa" onClick={() => retry()}>
          Try again
        </PillButton>
      </section>
    </main>
  );
}
