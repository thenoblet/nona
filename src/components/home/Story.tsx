import Image from "next/image";
import { couple, story } from "@/content/wedding";
import { photos, type Photo } from "@/content/images";
import { Reveal } from "@/components/ui/Reveal";
import { Eyebrow, Motto, Ornament } from "@/components/ui/Typography";

/** The letter to guests, floating on a band of white chrysanthemums. */
export function InvitationLetter() {
  return (
    <section aria-label="Your invitation" className="relative overflow-hidden bg-blush px-4 py-20 sm:px-6 sm:py-30">
      <Image
        src={photos.chrysanthemumsWide.src}
        alt=""
        fill
        sizes="100vw"
        placeholder="blur"
        className="object-cover"
        style={{ objectPosition: photos.chrysanthemumsWide.position }}
      />
      <Reveal className="relative mx-auto flex max-w-[720px] flex-col items-center gap-4.5 rounded-[var(--radius-paper)] bg-white/95 px-6 pt-14 pb-12 text-center shadow-[0_1px_2px_rgb(61_41_39/0.06),0_18px_44px_rgb(61_41_39/0.12)] outline outline-1 -outline-offset-[12px] outline-ember/45 sm:px-11 sm:pt-16 sm:pb-14">
        <p className="m-0 font-serif text-[32px] leading-tight italic sm:text-[40px]">To our dearest family &amp; friends,</p>
        <p className="m-0 text-base leading-[1.75] font-light text-mocha sm:text-[17px]">
          You have loved us, prayed for us and cheered us on, and it would mean the world to have you by our side as we
          begin our forever. Everything you need is right here: the dates, the places, and how to let us know you&apos;re
          coming.
        </p>
        <div className="flex flex-wrap justify-center gap-2.5">
          <span className="border border-hairline px-4.5 py-2.5 text-[13px] tracking-[0.08em] text-mocha">Three celebrations · two days</span>
          <span className="border border-hairline px-4.5 py-2.5 text-[13px] tracking-[0.08em] text-mocha">Kindly reply by 23 November</span>
        </div>
      </Reveal>
    </section>
  );
}

function Arch({ photo, priority }: { photo: Photo; priority?: boolean }) {
  return (
    <Image
      src={photo.src}
      alt={photo.alt}
      sizes="(min-width: 1024px) 320px, 80vw"
      placeholder="blur"
      priority={priority}
      className="arch-photo block aspect-[3/4] h-auto w-full rounded-t-[160px] object-cover"
      style={{ objectPosition: photo.position }}
    />
  );
}

function SmallPrint({ photo, caption, side }: { photo: Photo; caption: string; side: "left" | "right" }) {
  return (
    <div
      className={`print absolute -bottom-7 w-[110px] bg-white p-1.5 pb-6 shadow-[0_10px_24px_rgb(61_41_39/0.2)] sm:w-[120px] ${
        side === "left" ? "-left-4 sm:-left-9" : "-right-4 sm:-right-9"
      }`}
      style={{ transform: `rotate(${side === "left" ? -6 : 6}deg)` }}
    >
      <Image
        src={photo.src}
        alt={photo.alt}
        sizes="120px"
        className="block h-[120px] w-full object-cover sm:h-[130px]"
        style={{ objectPosition: photo.position }}
      />
      <span className="absolute inset-x-0 bottom-1 text-center font-script text-[15px]">{caption}</span>
    </div>
  );
}

function Chapter({
  when,
  title,
  children,
  photo,
  offset,
}: {
  when: string;
  title: string;
  children: React.ReactNode;
  photo: React.ReactNode;
  offset?: boolean;
}) {
  return (
    <Reveal as="article" className={`flex flex-col items-center gap-4 text-center ${offset ? "lg:pt-16" : ""}`}>
      <div className="relative w-full max-w-[300px] sm:max-w-[320px]">{photo}</div>
      <p className="mt-6 mb-0 text-xs uppercase tracking-[0.3em] text-ember-ink">{when}</p>
      <h3 className="m-0 font-serif text-[32px] font-normal italic sm:text-[34px]">{title}</h3>
      {children}
    </Reveal>
  );
}

export function Story() {
  return (
    <section id="story" className="bg-white px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-14 sm:gap-16">
        <Reveal className="flex flex-col items-center gap-3 text-center">
          <Eyebrow>Chapter one</Eyebrow>
          <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-7xl lg:text-[84px]">Our story</h2>
          <Ornament />
        </Reveal>
        <div className="grid grid-cols-1 items-start gap-x-10 gap-y-20 md:grid-cols-2 lg:grid-cols-3">
          <Chapter
            when={story.met.when}
            title={story.met.title}
            photo={
              <>
                <Arch photo={photos.howWeMetBw} />
                <SmallPrint photo={photos.earlyDays} caption="the early days" side="left" />
              </>
            }
          >
            <p className="m-0 max-w-[320px] font-serif text-xl leading-relaxed text-mocha">{story.met.text}</p>
          </Chapter>
          <Chapter
            offset
            when={story.asked.when}
            title={story.asked.title}
            photo={
              <>
                <Arch photo={photos.embraceBw} />
                <SmallPrint photo={photos.bouquet} caption="yes!" side="right" />
              </>
            }
          >
            <p className="m-0 max-w-[330px] font-serif text-[21px] leading-[1.55] text-mocha italic">
              <span className="text-ember">&ldquo;</span>
              {story.asked.quote}
              <span className="text-ember">&rdquo;</span>
            </p>
            <p className="m-0 font-script text-[30px] leading-tight">{story.asked.answer}</p>
          </Chapter>
          <Chapter
            when={story.forever.when}
            title={story.forever.title}
            photo={<Arch photo={photos.daisiesWrapped} />}
          >
            <p className="m-0 max-w-[320px] font-serif text-xl leading-relaxed text-mocha">{story.forever.text}</p>
            <p className="m-0 text-[30px] leading-tight">
              <Motto />.
            </p>
          </Chapter>
        </div>
        <span className="sr-only">{couple.motto}</span>
      </div>
    </section>
  );
}

/** Tilted prints and a black-and-white arch between sections. */
export function Gallery() {
  return (
    <section aria-label="Gallery" className="overflow-hidden px-5 pt-6 pb-24 sm:px-6 sm:pb-30">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-center gap-7">
        <Reveal
          className="print relative w-[200px] bg-white p-2.5 pb-10 shadow-[var(--shadow-print)] sm:w-[230px]"
          style={{ transform: "rotate(-5deg)" }}
        >
          <Image src={photos.bouquet.src} alt="Nancy holds her bouquet as they hug" sizes="230px" placeholder="blur" className="block h-[250px] w-full object-cover sm:h-[290px]" style={{ objectPosition: photos.bouquet.position }} />
          <span className="absolute inset-x-0 bottom-2 text-center font-script text-[22px]">she said yes</span>
        </Reveal>
        <Image
          src={photos.embraceBw.src}
          alt="Noblet and Nancy embrace, in black and white"
          sizes="300px"
          className="arch-photo hidden h-[420px] w-[300px] rounded-t-[150px] object-cover md:block"
          style={{ objectPosition: photos.embraceBw.position }}
        />
        <Reveal
          className="print relative w-[200px] bg-white p-2.5 pb-10 shadow-[var(--shadow-print)] sm:w-[230px]"
          style={{ transform: "rotate(4deg)" }}
        >
          <Image src={photos.kiss.src} alt="Noblet and Nancy share a kiss" sizes="230px" placeholder="blur" className="block h-[250px] w-full object-cover sm:h-[290px]" style={{ objectPosition: photos.kiss.position }} />
          <span className="absolute inset-x-0 bottom-2 text-center font-script text-[22px]">under the roses</span>
        </Reveal>
      </div>
    </section>
  );
}
