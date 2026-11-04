import Image from "next/image";
import { colours, couple, wedding } from "@/content/wedding";
import { accraDayAndFullMonth } from "@/lib/accra";
import type { FaqItem, GiftItem, PartyMember, RsvpSettings, TravelItem } from "@/lib/content/schema";
import { photos } from "@/content/images";
import { portraitOf, type SlotPhoto, type SlotPhotos } from "@/lib/site-images/photos";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { SitePhoto } from "@/components/ui/SitePhoto";
import { SwipeRow } from "@/components/ui/SwipeRow";
import { Eyebrow, Motto, SectionHeading } from "@/components/ui/Typography";
import { QrCode } from "@/components/ui/QrCode";
import { albumUrl, displayUrl, qrSvg } from "@/lib/qr";

export function Colours() {
  return (
    <section aria-labelledby="colours-h" className="bg-cocoa px-5 py-20 text-white sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-12 lg:flex-row lg:items-center lg:gap-14">
        <div className="flex flex-1 flex-col gap-4.5">
          <Eyebrow tone="ember">Dress code</Eyebrow>
          <h2 id="colours-h" className="m-0 font-script text-[56px] leading-none font-normal sm:text-[76px]">
            Our colours
          </h2>
          <p className="m-0 font-serif text-xl leading-[1.65] text-mist sm:text-[22px]">
            We would love to see our colours on everyone: white with warm cocoa and mocha, and a touch of burnt orange.
            Family members, look out for a message from us about fabric.
          </p>
          <TextLink href="#colours-h" className="self-start text-white">
            See outfit inspiration
          </TextLink>
        </div>
        <div className="grid flex-1 grid-cols-4 gap-3 sm:gap-4.5">
          {colours.map((colour) => (
            <div key={colour.name} className="flex flex-col items-center gap-3">
              <div
                className="aspect-[1/1.5] w-full rounded-full transition-transform duration-400 [@media(hover:hover)]:hover:-translate-y-2"
                style={{ background: colour.hex, border: colour.hex === "#3D2927" || colour.hex === "#6A524C" ? "1px solid rgb(255 255 255 / 0.45)" : undefined }}
              />
              <span className="text-center font-serif text-base text-linen italic sm:text-xl">{colour.name}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Portrait({ photo, name, role, large }: { photo: SlotPhoto | null; name: string; role: string; large?: boolean }) {
  const box = large ? "h-[200px] w-[150px] sm:h-[234px] sm:w-[176px]" : "h-[160px] w-[120px] sm:h-[186px] sm:w-[140px]";
  return (
    <figure className="m-0 flex flex-col items-center gap-2.5 text-center">
      <div className={`oval relative ${box}`}>
        <div aria-hidden className="oval-ring absolute top-[-8px] left-2 h-full w-full rounded-[50%] border border-ember" />
        {photo ? (
          <div className="absolute inset-0 overflow-hidden rounded-[50%] bg-tile">
            <SitePhoto photo={photo} fill blur sizes={large ? "176px" : "140px"} className="object-cover" />
          </div>
        ) : (
          /* Until the couple add this member's portrait in the admin (Site photos). */
          <div role="img" aria-label={`Portrait of ${name}, coming soon`} className="absolute inset-0 rounded-[50%] bg-tile" />
        )}
      </div>
      <figcaption className="mt-2 flex flex-col gap-0.5">
        <span className={`font-serif italic ${large ? "text-[28px]" : "text-2xl"}`}>{name}</span>
        <span className="text-[11px] uppercase tracking-[0.22em] text-mocha">{role}</span>
      </figcaption>
    </figure>
  );
}

export function Party({ party, photos: slotPhotos }: { party: PartyMember[]; photos: SlotPhotos }) {
  const leads = party.filter((member) => member.lead);
  const rest = party.filter((member) => !member.lead);
  return (
    <section aria-labelledby="party-h" className="px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-12 sm:gap-14">
        <Reveal>
          <SectionHeading id="party-h" eyebrow="Standing with us" title="The wedding party" />
        </Reveal>
        <div className="flex flex-wrap justify-center gap-x-10 gap-y-10 sm:gap-x-18">
          {leads.map((member) => (
            <Portrait key={member.id} photo={portraitOf(slotPhotos, member.id)} name={member.name} role={member.role} large />
          ))}
        </div>
        <div className="grid grid-cols-2 justify-items-center gap-x-4 gap-y-10 sm:flex sm:flex-wrap sm:justify-center sm:gap-x-9">
          {rest.map((member) => (
            <Portrait key={member.id} photo={portraitOf(slotPhotos, member.id)} name={member.name} role={member.role} />
          ))}
        </div>
      </div>
    </section>
  );
}

const travelTilts = ["0.5deg", "-0.6deg", "0.4deg"];

export function Travel({ travel }: { travel: TravelItem[] }) {
  return (
    <section id="travel" className="bg-tray px-5 pt-20 pb-24 sm:px-6 sm:pt-28 sm:pb-30">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-14 sm:gap-16">
        <Reveal>
          <SectionHeading eyebrow="For our travelling guests" title="Travel & stay" />
        </Reveal>
        <Reveal>
          <SwipeRow labels={travel.map((item) => item.title)}>
            {travel.map((item, index) => (
              <article
                key={item.title}
                className={`paper-card flex w-full flex-col items-center gap-3.5 rounded-[var(--radius-paper)] bg-white px-6 pt-10 pb-7.5 text-center shadow-[var(--shadow-paper)] sm:px-7.5 ${index === 1 ? "lg:mt-4" : ""}`}
                style={{ transform: `rotate(${travelTilts[index % travelTilts.length]})` }}
              >
                <Halo icon={item.icon} size="xl" />
                <h3 className="mt-1 mb-0 font-serif text-[32px] font-normal italic">{item.title}</h3>
                <p className="m-0 font-serif text-xl leading-relaxed text-mocha">{item.text}</p>
                <TextLink href="#travel" className="mt-auto">
                  {item.link}
                </TextLink>
              </article>
            ))}
          </SwipeRow>
        </Reveal>
      </div>
    </section>
  );
}

/** Asks guests to reply, or, while the couple have replies closed, says so with their message. */
export function RsvpBand({ rsvp }: { rsvp: RsvpSettings }) {
  const heading = "m-0 font-script text-[56px] leading-[1.1] font-normal sm:text-[84px]";
  const body = "m-0 text-base leading-[1.75] font-light text-mist sm:text-[17px]";
  return (
    <section id="rsvp" className="bg-cocoa px-5 py-20 text-center text-white sm:px-6 sm:py-28">
      <div className="mx-auto flex max-w-[1080px] flex-col items-center gap-14 lg:flex-row lg:justify-center lg:gap-20">
        <Reveal className="oval relative w-full max-w-[260px] sm:max-w-[340px]">
          <div aria-hidden className="oval-ring absolute inset-0 translate-x-3.5 -translate-y-3.5 rounded-t-[170px] border border-ember" />
          <Image
            src={photos.chrysanthemumsPortrait.src}
            alt={photos.chrysanthemumsPortrait.alt}
            sizes="(min-width: 640px) 340px, 260px"
            placeholder="blur"
            className="relative block aspect-[3/4] h-auto w-full rounded-t-[170px] object-cover"
            style={{ objectPosition: photos.chrysanthemumsPortrait.position }}
          />
        </Reveal>
        <div className="flex max-w-[560px] flex-1 flex-col items-center gap-5.5">
          {rsvp.open ? (
            <>
              <Eyebrow tone="ember">Répondez s&apos;il vous plaît</Eyebrow>
              <h2 className={heading}>Will you join us?</h2>
              <p className={body}>
                Kindly respond by <span className="text-white">{accraDayAndFullMonth(rsvp.replyBy)}</span>. It takes a minute.
                Tell us who&apos;s coming and which celebrations you&apos;ll join.
              </p>
              <PillLink href="/rsvp" variant="ember" size="lg">
                Respond now
              </PillLink>
            </>
          ) : (
            <>
              <h2 className={heading}>Replies have closed</h2>
              {/* Line breaks the couple type into the message are kept. */}
              <p className={`${body} whitespace-pre-line`}>{rsvp.closedMessage}</p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

export function Gifts({ gifts }: { gifts: GiftItem[] }) {
  return (
    <section id="gifts" className="px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-12">
        <Reveal>
          <SectionHeading
            eyebrow="Gifts"
            title="With gratitude"
            lead="Your presence is the greatest gift. For those who have asked, here are a few ways to bless our new home."
          />
        </Reveal>
        <div className="grid grid-cols-1 border-y border-hairline md:grid-cols-3">
          {gifts.map((gift, index) => (
            // TODO: link to the registry and reveal account details.
            <a
              key={gift.title}
              href="#gifts"
              className={`flex flex-col items-center gap-1.5 px-5 py-8 text-center no-underline transition-colors duration-300 hover:bg-blush ${
                index > 0 ? "border-t border-hairline md:border-t-0 md:border-l" : ""
              }`}
            >
              <span className="font-serif text-[30px] italic">{gift.title}</span>
              <span className="text-sm text-mocha">{gift.text}</span>
              <span className="ember-link mt-2 pb-0.5 text-xs uppercase tracking-[0.18em]">{gift.action}</span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

export async function AlbumTeaser() {
  const url = await albumUrl();
  const svg = await qrSvg(url, "QR code that opens the shared album");
  return (
    <section id="album" className="bg-tray px-5 py-20 sm:px-6 sm:py-28">
      <div className="mx-auto flex max-w-[1100px] flex-col items-center gap-14 lg:flex-row lg:gap-16">
        <div className="flex flex-1 flex-col gap-5">
          <Eyebrow>Our shared album</Eyebrow>
          <h2 className="m-0 font-script text-[56px] leading-none font-normal sm:text-[76px]">Capture it with us</h2>
          <p className="m-0 font-serif text-xl leading-[1.65] text-mocha sm:text-[22px]">
            Scan the code on your table to share photos and videos straight from your phone. Browse everyone&apos;s moments,
            download your own, and leave us a wish to keep forever.
          </p>
          <div className="my-1 flex flex-wrap gap-x-6.5 gap-y-2.5 font-serif text-[19px]">
            <span className="flex items-center gap-2.5"><Halo icon="phone" size="sm" />No app</span>
            <span className="flex items-center gap-2.5"><Halo icon="user" size="sm" />No sign-up</span>
            <span className="flex items-center gap-2.5"><Halo icon="download" size="sm" />Keep your own</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-6.5 gap-y-3">
            <PillLink href="/album" variant="cocoa">Open the album</PillLink>
            <TextLink href="/wishes">Leave a wish</TextLink>
          </div>
        </div>
        <Reveal className="print flex w-full max-w-[300px] flex-col items-center gap-3.5 rounded-[var(--radius-paper)] bg-white px-7 pt-7 pb-6 shadow-[0_1px_2px_rgb(61_41_39/0.06),0_18px_40px_rgb(61_41_39/0.1)]" style={{ transform: "rotate(-1.5deg)" }}>
          <QrCode svg={svg} className="aspect-square w-full max-w-[200px]" />
          <span className="font-serif text-[22px] italic">Scan to share</span>
          <span className="text-xs tracking-[0.08em] break-all text-mocha">{displayUrl(url)}</span>
        </Reveal>
      </div>
    </section>
  );
}

export function Faq({ faq }: { faq: FaqItem[] }) {
  return (
    <section aria-labelledby="faq-h" className="px-5 py-20 sm:px-6 sm:py-26">
      <div className="mx-auto flex max-w-[820px] flex-col gap-10">
        <div className="flex flex-col items-center gap-3.5 text-center">
          <Eyebrow>Good to know</Eyebrow>
          <h2 id="faq-h" className="m-0 font-serif text-5xl leading-tight font-normal sm:text-[56px]">
            Questions
          </h2>
        </div>
        <div className="flex flex-col border-t border-hairline">
          {faq.map((item, index) => (
            <details key={item.question} open={index === 0} className="group border-b border-hairline py-5.5">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-serif text-[22px] transition-colors hover:text-ember-ink sm:text-[26px] [&::-webkit-details-marker]:hidden">
                {item.question}
                <Icon name="chevron" size={20} strokeWidth={1.6} className="shrink-0 text-ember transition-transform group-open:rotate-180" />
              </summary>
              <p className="mt-3 mb-0 text-base leading-[1.75] font-light text-mocha">{item.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-mocha px-5 pt-18 pb-32 text-center text-white sm:px-6 sm:pb-28">
      <div className="mx-auto flex max-w-[720px] flex-col items-center gap-4">
        <span className="font-script text-[64px] leading-none text-ember">{couple.monogram}</span>
        <p className="mt-1 mb-0 text-[40px] leading-tight text-white">
          <Motto />
        </p>
        <p className="m-0 font-serif text-[22px] text-linen italic">
          With all our love, {couple.groom} &amp; {couple.bride}
        </p>
        <p className="m-0 text-[13px] uppercase tracking-[0.24em] text-mist">
          {couple.hashtag} · {wedding.dateShort}
        </p>
      </div>
    </footer>
  );
}
