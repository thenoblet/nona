import Link from "next/link";
import { Fragment } from "react";
import { celebrationPlace } from "@/lib/content/place";
import type { Celebration, SiteContent } from "@/lib/content/schema";
import { PillAnchor, TextLink } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/Typography";

const tilts = ["-0.8deg", "0.6deg", "-0.4deg"];

function Detail({ icon, children }: { icon: "clock" | "pin" | "dress"; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3.5">
      <Halo icon={icon} size="md" />
      <span>{children}</span>
    </div>
  );
}

function CelebrationCard({
  celebration,
  venues,
  index,
}: {
  celebration: Celebration;
  venues: SiteContent["venues"];
  index: number;
}) {
  const { place, gpsLine, directionsUrl } = celebrationPlace(celebration, venues);
  // Under the place: the venue's GhanaPost GPS, then any extra note.
  const placeNotes = [gpsLine, celebration.placeDetail].filter((note): note is string => Boolean(note));
  return (
    <Reveal
      as="article"
      className={`paper-card flex flex-col items-center gap-4.5 rounded-[var(--radius-paper)] bg-white px-6 pt-11 pb-8 text-center shadow-[var(--shadow-paper)] sm:px-7.5 ${
        index === 0 ? "outline outline-1 -outline-offset-[12px] outline-ember/45" : ""
      } ${index === 1 ? "lg:mt-[18px]" : ""}`}
      style={{ transform: `rotate(${tilts[index % tilts.length]})` }}
    >
      <div className="flex flex-col items-center gap-1">
        <span className="text-[11px] uppercase tracking-[0.3em] text-mocha">{celebration.weekday}</span>
        <span className="font-serif text-7xl leading-none font-light lining-nums">{celebration.day}</span>
        <span className="text-[11px] uppercase tracking-[0.3em] text-mocha">{celebration.month}</span>
      </div>
      <h3 className="m-0 font-serif text-[32px] leading-tight font-normal italic sm:text-[34px]">{celebration.name}</h3>
      <div className="flex flex-col gap-3 self-stretch text-left font-serif text-[19px]">
        <Detail icon="clock">{celebration.time}</Detail>
        <Detail icon="pin">
          {place}
          {placeNotes.map((note) => (
            <Fragment key={note}>
              <br />
              <span className="font-sans text-xs tracking-[0.08em] text-mocha">{note}</span>
            </Fragment>
          ))}
        </Detail>
        <Detail icon="dress">{celebration.dress}</Detail>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-center gap-x-5.5 gap-y-2 pt-2.5">
        <PillAnchor href={`/calendar?events=${celebration.id}`} download variant="cocoa">
          Add to calendar
        </PillAnchor>
        <TextLink href={directionsUrl}>Directions</TextLink>
      </div>
    </Reveal>
  );
}

export function Celebrations({ celebrations, venues }: { celebrations: Celebration[]; venues: SiteContent["venues"] }) {
  return (
    <section id="celebrations" className="bg-tray px-5 pt-20 pb-24 sm:px-6 sm:pt-28 sm:pb-30">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-14 sm:gap-16">
        <Reveal>
          <SectionHeading eyebrow="Save the dates" title="The celebrations" />
        </Reveal>
        <div className="grid grid-cols-1 items-stretch gap-x-8 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
          {celebrations.map((celebration, index) => (
            <CelebrationCard key={celebration.id} celebration={celebration} venues={venues} index={index} />
          ))}
        </div>
        <Reveal className="flex flex-col items-center gap-3 text-center sm:gap-3.5">
          <p className="m-0 font-serif text-xl text-mocha italic sm:text-[22px]">Every part of each day, hour by hour</p>
          <Link
            href="/programme"
            className="press inline-flex min-h-13 items-center gap-3 rounded-full border border-cocoa bg-white py-2 pr-2.5 pl-6.5 text-[11.5px] uppercase tracking-[0.2em] text-cocoa no-underline transition-colors hover:text-ember-ink sm:min-h-13.5 sm:pl-7 sm:text-xs"
          >
            See the order of the day
            <span aria-hidden className="flex size-8.5 items-center justify-center rounded-full bg-ember text-cocoa sm:size-9">
              <Icon name="arrow" size={16} strokeWidth={2} />
            </span>
          </Link>
        </Reveal>
      </div>
    </section>
  );
}
