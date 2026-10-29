import { landmarks, venues } from "@/content/wedding";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/Typography";
import { CopyButton } from "./CopyButton";
import { VenueMap, type MapPlace } from "./VenueMap";

type Place = {
  n: number;
  eyebrow: string;
  tag: string;
  name: string;
  address: string;
  gps: string;
  mapsUrl: string;
  note?: string;
  coords?: { lat: number; lng: number };
};

const places: Place[] = [
  { n: 1, eyebrow: "White wedding · Thanksgiving", tag: "Church", ...venues.church },
  { n: 2, eyebrow: "Reception", tag: "Reception", ...venues.reception },
];

/** Only places with a confirmed pin go on the map. */
const pins: MapPlace[] = places.flatMap((p) =>
  p.coords ? [{ n: p.n, label: p.tag, name: p.name, ...p.coords, directionsUrl: p.mapsUrl }] : [],
);

function Place({ p }: { p: Place }) {
  const external = p.mapsUrl.startsWith("http");
  return (
    <div className="flex items-start gap-4.5 border-b border-hairline py-6">
      <span
        aria-hidden
        className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-cocoa text-sm font-medium text-white shadow-[0_0_0_5px_var(--color-halo)]"
      >
        {p.n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-[11px] uppercase tracking-[0.24em] text-mocha">{p.eyebrow}</span>
        <h3 className="m-0 font-serif text-[28px] leading-tight font-normal italic sm:text-[30px]">{p.name}</h3>
        <span className="font-serif text-[19px] text-mocha">{p.address}</span>
        {p.note ? <span className="text-[13px] tracking-[0.04em] text-mocha">{p.note}</span> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-5.5 gap-y-2.5">
          <span className="inline-flex items-center gap-2.5 rounded-full border border-hairline bg-blush py-0.5 pr-0.5 pl-4 text-xs tracking-[0.08em]">
            GPS · {p.gps}
            <CopyButton text={p.gps} label={`GPS code for ${p.name}`} />
          </span>
          <a
            href={p.mapsUrl}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
            className="ember-link inline-flex min-h-11 items-center py-3 text-xs uppercase tracking-[0.16em] no-underline"
          >
            Get directions
          </a>
        </div>
      </div>
    </div>
  );
}

export function MapSection() {
  return (
    <section id="map" className="bg-white px-5 pt-20 pb-24 sm:px-6 sm:pt-28 sm:pb-30">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-12 sm:gap-14">
        <Reveal>
          <SectionHeading
            eyebrow="Tepa · Ashanti"
            title="Finding your way"
            lead="Two places, a minute apart, near Rexco and Amel Junction. Tap either one for turn-by-turn directions on your phone."
          />
        </Reveal>
        <div className="flex flex-col-reverse gap-10 lg:flex-row lg:items-center lg:gap-16">
          <div className="min-w-0 flex-1 border-t border-hairline lg:basis-[380px]">
            {places.map((p) => (
              <Place key={p.n} p={p} />
            ))}
          </div>
          <Reveal className="min-w-0 flex-[1.4] rounded-[var(--radius-paper)] bg-tray p-4 sm:p-7 lg:basis-[520px]">
            <div className="paper-card rounded-[var(--radius-paper)] bg-white p-2 shadow-[var(--shadow-paper)] sm:p-3">
              <VenueMap
                places={pins}
                landmarks={landmarks.map((l) => ({ name: l.name, ...l.coords }))}
                label="Satellite map of Tepa showing the church, the reception venue and nearby landmarks"
              />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
