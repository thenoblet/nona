import Image from "next/image";
import { connection } from "next/server";
import { Suspense } from "react";
import { couple, wedding } from "@/content/wedding";
import { photos } from "@/content/images";
import { accraDayAndFullMonth } from "@/lib/accra";
import { getSiteContent } from "@/lib/content/get";
import { PillLink } from "@/components/ui/Button";
import { Motto, Ornament } from "@/components/ui/Typography";

/** The opened invitation, with a daisy print tucked behind its corner. */
export function InvitationCard() {
  const photo = photos.daisiesWrapped;
  return (
    <>
      <div className="relative mt-2 w-[342px] max-w-full">
        <div
          className="absolute -top-8.5 -right-3.5 w-[118px] animate-rise bg-white p-1.5 pb-6.5 shadow-[0_10px_24px_rgb(0_0_0/0.3)]"
          style={{ transform: "rotate(8deg)", animationDelay: "500ms" }}
        >
          <Image
            src={photo.src}
            alt={photo.alt}
            sizes="118px"
            className="block h-33 w-full object-cover"
            style={{ objectPosition: photo.position }}
          />
          <span className="absolute inset-x-0 bottom-1 text-center font-script text-[15px] text-cocoa">for you</span>
        </div>

        <div
          className="relative animate-rise rounded-[var(--radius-paper)] bg-white p-3.5 text-cocoa shadow-[0_2px_4px_rgb(0_0_0/0.2),0_28px_56px_rgb(0_0_0/0.38)]"
          style={{ animationDelay: "150ms" }}
        >
          <div className="flex flex-col items-center gap-4 border border-ember/60 px-5.5 pt-10 pb-8 text-center">
            <p className="text-[11px] uppercase tracking-[0.32em] text-mocha">Together with their families</p>
            <h1
              tabIndex={-1}
              className="font-script text-[clamp(44px,14vw,58px)] leading-[1.1] font-normal focus:outline-none"
            >
              {couple.groom} <span className="text-ember">&amp;</span> {couple.bride}
            </h1>
            <Ornament width={140} />
            <p className="font-serif text-[21px] leading-[1.4] text-mocha italic">
              request the pleasure of your company as they begin their forever
            </p>
            <p className="font-serif text-[26px] font-medium tracking-[0.04em]">{wedding.dateShort}</p>
            <p className="text-xs uppercase tracking-[0.22em] text-mocha">
              {wedding.town} · {wedding.region}
            </p>
            <PillLink href="/home" variant="cocoa" className="mt-2">
              Enter our website
            </PillLink>
            <Motto className="mt-1 text-[26px] text-ember" />
          </div>
        </div>
      </div>

      <p
        className="mt-6.5 animate-rise text-center text-[13px] tracking-[0.06em] text-mist"
        style={{ animationDelay: "700ms" }}
      >
        {/* A space holds the line's height until the date arrives. */}
        <Suspense fallback={"\u00a0"}>
          <ReplyBy />
        </Suspense>
      </p>
    </>
  );
}

/** Read at request time, so the reply-by date and closing replies in the admin show up without a rebuild. */
async function ReplyBy() {
  await connection();
  const { rsvp } = await getSiteContent();
  if (!rsvp.open) return "Replies have closed";
  return (
    <>
      Kindly reply by <span className="text-white">{accraDayAndFullMonth(rsvp.replyBy)}</span>
    </>
  );
}
