import { celebrations, type Celebration } from "@/content/wedding";
import { PillLink, TextLink } from "@/components/ui/Button";
import { Halo } from "@/components/ui/Halo";
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

function CelebrationCard({ c, index }: { c: Celebration; index: number }) {
  return (
    <Reveal
      as="article"
      className={`paper-card flex flex-col items-center gap-4.5 rounded-[var(--radius-paper)] bg-white px-6 pt-11 pb-8 text-center shadow-[var(--shadow-paper)] sm:px-7.5 ${
        index === 0 ? "outline outline-1 -outline-offset-[12px] outline-ember/45" : ""
      } ${index === 1 ? "lg:mt-[18px]" : ""}`}
      style={{ transform: `rotate(${tilts[index % tilts.length]})` }}
    >
      <div className="flex flex-col items-center gap-1">
        <span className="text-[11px] uppercase tracking-[0.3em] text-mocha">{c.weekday}</span>
        <span className="font-serif text-7xl leading-none font-light lining-nums">{c.day}</span>
        <span className="text-[11px] uppercase tracking-[0.3em] text-mocha">{c.month}</span>
      </div>
      <h3 className="m-0 font-serif text-[32px] leading-tight font-normal italic sm:text-[34px]">{c.name}</h3>
      <div className="flex flex-col gap-3 self-stretch text-left font-serif text-[19px]">
        <Detail icon="clock">{c.time}</Detail>
        <Detail icon="pin">
          {c.place}
          {c.placeDetail ? (
            <>
              <br />
              <span className="font-sans text-xs tracking-[0.08em] text-mocha">{c.placeDetail}</span>
            </>
          ) : null}
        </Detail>
        <Detail icon="dress">{c.dress}</Detail>
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-center gap-x-5.5 gap-y-2 pt-2.5">
        {/* TODO: generate .ics calendar files per celebration. */}
        <PillLink href="#celebrations" variant="cocoa">
          Add to calendar
        </PillLink>
        <TextLink href={c.directionsUrl}>Directions</TextLink>
      </div>
    </Reveal>
  );
}

export function Celebrations() {
  return (
    <section id="celebrations" className="bg-tray px-5 pt-20 pb-24 sm:px-6 sm:pt-28 sm:pb-30">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-14 sm:gap-16">
        <Reveal>
          <SectionHeading eyebrow="Save the dates" title="The celebrations" />
        </Reveal>
        <div className="grid grid-cols-1 items-stretch gap-x-8 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
          {celebrations.map((c, i) => (
            <CelebrationCard key={c.id} c={c} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}
