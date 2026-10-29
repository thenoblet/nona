import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { listWishes } from "@/lib/data/wishes";
import { shareDefaults } from "@/lib/share";
import { PhoneHeader } from "@/components/layout/PhoneHeader";
import { Paper } from "@/components/ui/Paper";
import { Reveal } from "@/components/ui/Reveal";
import { Eyebrow, Motto, Ornament } from "@/components/ui/Typography";
import { TextWish, VideoWish, VoiceWish } from "@/components/wishes/WishCards";
import { WishComposer } from "@/components/wishes/WishComposer";

export const metadata: Metadata = {
  title: "Wishes",
  description: "Leave Noblet and Nancy a wish: words, a voice note or a short video.",
  openGraph: {
    ...shareDefaults,
    title: "Leave us a wish · Noblet & Nancy",
    description: "Words, a voice note or a short video. We'll treasure every one.",
    url: "/wishes",
  },
};

/** The guestbook: a composer on a tray band, then the wishes wall. */
export default function WishesPage() {
  return (
    <main className="min-h-dvh bg-white pb-28">
      <PhoneHeader tone="light" backHref="/album" backLabel="Back to the album">
        <div className="flex flex-col items-center gap-2.5 text-center">
          <Eyebrow className="mt-1.5">Our guestbook</Eyebrow>
          <h1 className="m-0 font-script text-[56px] leading-[1.1] font-normal sm:text-[64px]">Leave us a wish</h1>
          <Ornament width={140} draw />
          <p className="m-0 font-serif text-xl leading-normal text-mocha">
            Words, a voice note or a short video. We&apos;ll treasure every one.
          </p>
        </div>
      </PhoneHeader>

      <section aria-label="Write your wish" className="bg-tray px-4 pt-6 pb-7 sm:px-8 sm:py-10">
        <Paper className="mx-auto max-w-xl px-4.5 pt-5 pb-5.5 sm:px-7 sm:pt-7 sm:pb-8">
          <WishComposer />
        </Paper>
      </section>

      <section aria-labelledby="wall-h" className="mx-auto flex max-w-xl flex-col gap-5.5 px-4.5 pt-10 pb-7 sm:px-8">
        <div className="flex flex-col items-center gap-1 text-center">
          <h2 id="wall-h" className="m-0 font-script text-[46px] leading-[1.1] font-normal">
            The wishes wall
          </h2>
          <Eyebrow as="span" className="tracking-[0.24em]">
            Newest first
          </Eyebrow>
        </div>
        <Suspense fallback={<WallSkeleton />}>
          <WishesWall />
        </Suspense>
      </section>

      <p className="mt-2 mb-10 text-center text-[30px] text-ember">
        <Motto />
      </p>
    </main>
  );
}

/** Read at request time, so a wish sent from the form shows up straight away. */
async function WishesWall() {
  await connection();
  const wishes = await listWishes();

  if (!wishes.length) {
    return <p className="m-0 text-center font-serif text-xl text-mocha italic">No wishes yet. Be the first to leave one.</p>;
  }

  // Text wishes count separately so their papers keep cycling blush, white, cocoa.
  const paperIndex: number[] = [];
  let texts = 0;
  for (const wish of wishes) paperIndex.push(wish.kind === "text" ? texts++ : 0);

  return (
    <ul className="m-0 flex list-none flex-col gap-5.5 p-0">
      {wishes.map((wish, i) => (
        <Reveal as="li" key={wish.id}>
          {wish.kind === "text" ? (
            <TextWish wish={wish} index={paperIndex[i]} />
          ) : wish.kind === "voice" ? (
            <VoiceWish wish={wish} index={i} />
          ) : (
            <VideoWish wish={wish} index={i} />
          )}
        </Reveal>
      ))}
    </ul>
  );
}

function WallSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading wishes" className="flex flex-col gap-5.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-36 animate-pulse rounded-[var(--radius-paper)] bg-blush" />
      ))}
    </div>
  );
}
