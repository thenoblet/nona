import { venues } from "@/content/wedding";
import { Reveal } from "@/components/ui/Reveal";
import { SectionHeading } from "@/components/ui/Typography";
import { CopyButton } from "./CopyButton";

const places = [
  { n: 1, eyebrow: "White wedding · Thanksgiving", ...venues.church },
  { n: 2, eyebrow: "Reception", ...venues.reception },
  { n: 3, eyebrow: "Where to stay", ...venues.hotel },
];

function Place({ p }: { p: (typeof places)[number] }) {
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

function pin(x: number, y: number, n: number) {
  return (
    <g transform={`translate(${x} ${y})`} key={n}>
      <path d="M0 0C0 0-17-15-17-28a17 17 0 0 1 34 0C17-15 0 0 0 0z" fill="var(--color-cocoa)" stroke="#fff" strokeWidth="2" />
      <circle cx="0" cy="-28" r="10" fill="var(--color-ember)" />
      <text x="0" y="-24" textAnchor="middle" fontFamily="var(--font-jost)" fontSize="12" fontWeight="600" fill="var(--color-cocoa)">
        {n}
      </text>
    </g>
  );
}

function tag(x: number, y: number, w: number, text: string) {
  return (
    <g transform={`translate(${x} ${y})`} key={text}>
      <rect width={w} height="30" rx="15" fill="#fff" filter="url(#nonaTagShadow)" />
      <text x={w / 2} y="20" textAnchor="middle" fontFamily="var(--font-cormorant)" fontStyle="italic" fontSize="17" fill="var(--color-cocoa)">
        {text}
      </text>
    </g>
  );
}

function landmark(x: number, y: number) {
  return (
    <g key={`${x}-${y}`}>
      <rect x={x - 5} y={y - 5} width="10" height="10" fill="none" stroke="var(--color-mocha)" strokeWidth="1.2" transform={`rotate(45 ${x} ${y})`} />
      <text x={x + 12} y={y + 5} fontFamily="var(--font-cormorant)" fontStyle="italic" fontSize="16" fill="var(--color-mocha)">
        [Landmark]
      </text>
    </g>
  );
}

const road = "M-10 318C110 296 210 262 300 238S470 176 580 128";
const streets = ["M150 -10L196 450", "M300 238L368 450", "M372 -10L418 196"];

/**
 * Hand-drawn, not-to-scale map of Tepa. Redraw it to match the real layout once
 * the church, hotel and landmarks are confirmed.
 */
function TownMap() {
  return (
    <svg
      viewBox="0 0 560 440"
      role="img"
      aria-label="Illustrated map of Tepa showing the church, the reception venue and the guest hotel. Not to scale."
      className="block h-auto w-full"
    >
      <defs>
        <filter id="nonaTagShadow" x="-20%" y="-40%" width="140%" height="200%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#3D2927" floodOpacity="0.14" />
        </filter>
        <path id="nonaMainRoad" d={road} />
      </defs>
      <rect width="560" height="440" fill="var(--color-blush)" />
      <g fill="var(--color-tray)">
        <rect x="34" y="40" width="92" height="70" rx="6" />
        <rect x="200" y="36" width="120" height="84" rx="6" />
        <rect x="226" y="300" width="96" height="96" rx="6" />
        <rect x="410" y="250" width="118" height="80" rx="6" />
        <rect x="44" y="350" width="120" height="60" rx="6" />
        <rect x="440" y="40" width="80" height="54" rx="6" />
      </g>
      <g fill="none" strokeLinecap="round">
        {streets.map((d) => (
          <g key={d}>
            <path d={d} stroke="#E6D9D2" strokeWidth="12" />
            <path d={d} stroke="#fff" strokeWidth="7" />
          </g>
        ))}
        <path d={road} stroke="#E6D9D2" strokeWidth="20" />
        <path d={road} stroke="#fff" strokeWidth="13" />
      </g>
      <text fontFamily="var(--font-jost)" fontSize="10" letterSpacing="2.5" fill="var(--color-mocha)">
        <textPath href="#nonaMainRoad" startOffset="6%">
          [MAIN ROAD]
        </textPath>
      </text>
      <path
        d="M170 168L180 262Q182 284 206 278L296 240Q316 234 322 254L334 296"
        fill="none"
        stroke="var(--color-ember)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="1 8"
      />
      {landmark(70, 248)}
      {landmark(250, 170)}
      {landmark(470, 220)}
      {pin(170, 168, 1)}
      {pin(334, 300, 2)}
      {pin(452, 150, 3)}
      {tag(72, 94, 84, "Church")}
      {tag(352, 268, 104, "Reception")}
      {tag(476, 104, 72, "Hotel")}
      <g transform="translate(518 384)">
        <circle r="20" fill="#fff" stroke="var(--color-hairline)" />
        <path d="M0-13L5 2H-5z" fill="var(--color-ember)" />
        <path d="M0 13L5-2H-5z" fill="var(--color-mist)" />
        <text x="0" y="-25" textAnchor="middle" fontFamily="var(--font-jost)" fontSize="10" letterSpacing="1.5" fill="var(--color-mocha)">
          N
        </text>
      </g>
      <text x="24" y="424" fontFamily="var(--font-jost)" fontSize="10" letterSpacing="2.5" fill="var(--color-mocha)">
        TEPA · NOT TO SCALE
      </text>
    </svg>
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
            lead="One little town, three places to know. Tap any of them for turn-by-turn directions on your phone."
          />
        </Reveal>
        <div className="flex flex-col-reverse gap-10 lg:flex-row lg:items-center lg:gap-16">
          <div className="min-w-0 flex-1 border-t border-hairline lg:basis-[380px]">
            {places.map((p) => (
              <Place key={p.n} p={p} />
            ))}
          </div>
          <Reveal className="min-w-0 flex-[1.4] rounded-[var(--radius-paper)] bg-tray p-4 sm:p-7 lg:basis-[520px]">
            <div className="paper-card rounded-[var(--radius-paper)] bg-white p-2 shadow-[var(--shadow-paper)] sm:p-3" style={{ transform: "rotate(0.6deg)" }}>
              <TownMap />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
