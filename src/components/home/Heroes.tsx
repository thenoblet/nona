import Image from "next/image";
import type { CSSProperties } from "react";
import { couple, wedding } from "@/content/wedding";
import { photos } from "@/content/images";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Eyebrow, Motto, Ornament } from "@/components/ui/Typography";
import { Countdown } from "./Countdown";

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

function Names({ className = "" }: { className?: string }) {
  return (
    <h1
      className={`m-0 animate-rise font-script text-[64px] leading-[1.05] font-normal text-white sm:text-[96px] lg:text-[140px] ${className}`}
      style={{ ...delay(300), animationDuration: "1600ms" }}
    >
      {couple.groom} <span className="text-ember">&amp;</span> {couple.bride}
    </h1>
  );
}

const wrap = "relative bg-cocoa px-5 text-center text-white sm:px-6";
const inner = "mx-auto flex max-w-[900px] flex-col items-center";

/**
 * Before the wedding. The pre-wedding shoot photo will go behind this hero
 * (add it as a darkened next/image with `fill` when the shoot is done).
 */
export function HeroBefore() {
  return (
    <section id="top" className={`${wrap} pt-16 pb-20 sm:pt-22 sm:pb-26`}>
      <div className={`${inner} gap-6 sm:gap-7`}>
        <Eyebrow tone="ember" className="animate-rise" >Together with their families</Eyebrow>
        <Names />
        <Ornament draw dot />
        <p className="m-0 max-w-[620px] animate-rise font-serif text-2xl leading-snug text-linen italic sm:text-[28px]" style={delay(700)}>
          request the pleasure of your company as they begin their forever
        </p>
        <div className="flex animate-rise flex-col gap-1.5" style={delay(900)}>
          <p className="m-0 font-serif text-[28px] font-medium tracking-[0.04em] sm:text-[34px]">{wedding.dateLong}</p>
          <p className="m-0 text-[13px] uppercase tracking-[0.24em] text-mist sm:text-sm">
            {wedding.town} · {wedding.region}
          </p>
        </div>
        <div className="flex w-full animate-rise justify-center" style={delay(1100)}>
          <Countdown to={wedding.countdownTo} />
        </div>
        <div className="mt-2 flex animate-rise flex-col items-center gap-2 sm:flex-row sm:gap-6" style={delay(1300)}>
          <PillLink href="/rsvp" variant="ember" size="lg">
            Respond to your invitation
          </PillLink>
          <TextLink href="#celebrations" className="text-white">
            View the celebrations
          </TextLink>
        </div>
      </div>
    </section>
  );
}

/** Wedding weekend: photo sharing comes first. */
/** `now` is what is on right now; nothing is shown for it when the schedule is empty. */
export function HeroDay({ todayLabel, now }: { todayLabel: string; now: { title: string; place: string } | null }) {
  return (
    <section id="top" className={`${wrap} pt-14 pb-20 sm:pt-20 sm:pb-24`}>
      <div className={`${inner} gap-6`}>
        <Eyebrow tone="ember" className="animate-rise">
          {todayLabel} · {wedding.town}
        </Eyebrow>
        <Names />
        <Ornament draw dot />
        <p className="m-0 max-w-[640px] animate-rise font-serif text-2xl leading-snug text-linen italic sm:text-3xl" style={delay(700)}>
          Today&apos;s the day. Thank you for being here with us.
        </p>
        {now ? (
          <div
            className="flex animate-rise flex-wrap items-center justify-center gap-x-3.5 gap-y-1 rounded-[28px] border border-ember/50 px-5 py-3 sm:rounded-full"
            style={delay(900)}
          >
            <span className="live-dot" aria-hidden />
            <span className="text-[11px] uppercase tracking-[0.26em] text-ember">Happening now</span>
            <span className="font-serif text-xl">
              {now.title} · {now.place}
            </span>
          </div>
        ) : null}
        <div className="mt-2 flex w-full animate-rise flex-col items-center gap-2 sm:w-auto sm:flex-row sm:gap-6" style={delay(1100)}>
          <PillLink href="/album" variant="ember" size="lg" icon="camera" className="w-full sm:w-auto">
            Share your photos &amp; videos
          </PillLink>
          <TextLink href="#today" className="text-white">
            Find your seat
          </TextLink>
        </div>
      </div>
    </section>
  );
}

/** After the wedding: a thank-you, with the album right below. */
export function HeroAfter() {
  return (
    <section id="top" className={`${wrap} pt-16 pb-20 sm:pt-24 sm:pb-28`}>
      <div className="mx-auto flex max-w-[1160px] flex-col items-center gap-12 lg:flex-row lg:gap-18">
        <div className="flex flex-1 flex-col items-center gap-5.5">
          <Eyebrow tone="ember" className="animate-rise">
            {wedding.dateShort} · {wedding.town}
          </Eyebrow>
          <h1
            className="m-0 animate-rise font-script text-[80px] leading-[1.05] font-normal sm:text-[120px] lg:text-[152px]"
            style={{ ...delay(300), animationDuration: "1600ms" }}
          >
            Thank you
          </h1>
          <p className="-mt-2 mb-0 animate-rise font-serif text-[28px] leading-snug text-linen italic sm:text-4xl" style={delay(550)}>
            for celebrating with us
          </p>
          <Ornament draw dot />
          <p className="m-0 max-w-[600px] animate-rise text-base leading-relaxed font-light text-mist sm:text-[17px]" style={delay(800)}>
            Your love, your prayers and your dancing made our weekend. Every photo and video you shared lives here now,
            ready to relive and download.
          </p>
          <div className="mt-2 flex animate-rise flex-col items-center gap-2 sm:flex-row sm:gap-6" style={delay(1000)}>
            <PillLink href="#album" variant="ember" size="lg">
              Relive the day
            </PillLink>
            <TextLink href="#wishes" className="text-white">
              Read your wishes
            </TextLink>
          </div>
          <p className="mt-3 mb-0 flex animate-rise flex-col items-center font-script text-ember" style={delay(1200)}>
            <Motto amp="text-white" className="text-[34px] sm:text-[40px]" />
            <span className="text-2xl text-linen sm:text-[28px]">
              {couple.groom} &amp; {couple.bride}
            </span>
          </p>
        </div>
        <div
          className="print relative w-[240px] shrink-0 animate-rise bg-white p-3 pb-14 shadow-[0_18px_44px_rgb(0_0_0/0.35)] sm:w-[300px]"
          style={{ transform: "rotate(4deg)", ...delay(700) }}
        >
          <Image
            src={photos.chrysanthemumsPortrait.src}
            alt={photos.chrysanthemumsPortrait.alt}
            sizes="300px"
            className="block aspect-[3/4] h-auto w-full object-cover"
            style={{ objectPosition: photos.chrysanthemumsPortrait.position }}
            placeholder="blur"
          />
          <span className="absolute inset-x-0 bottom-3.5 text-center font-script text-[26px] text-cocoa">with all our love</span>
        </div>
      </div>
    </section>
  );
}
