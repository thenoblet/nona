import Image from "next/image";
import mcPortrait from "../../../public/images/party/mc.jpg";
import { TextLink } from "@/components/ui/Button";
import { stateOf, type ProgrammeNow } from "@/components/today/day";
import { celebrationPlace } from "@/lib/content/place";
import type { Celebration, ScheduleItem, SiteContent } from "@/lib/content/schema";
import { formatClock } from "@/lib/content/times";

/** "Saturday 5 December". */
export function longDate(celebration: Celebration): string {
  return `${celebration.weekday} ${Number(celebration.day)} ${celebration.month}`;
}

/** A directions link that works from this page: "#map" is the map on the home page. */
function directionsFrom(url: string): string {
  return url.startsWith("#") ? `/home${url}` : url;
}

/**
 * One celebration on the Order of the day page: its date, name, place and directions, then its
 * items as a timeline. On the wedding weekend, finished items fade and the one on now is marked.
 */
export function ProgrammeCelebration({
  celebration,
  venues,
  items,
  standing,
}: {
  celebration: Celebration;
  venues: SiteContent["venues"];
  /** Its items, each with its index in the whole programme, which `standing` counts by. */
  items: { item: ScheduleItem; index: number }[];
  standing: ProgrammeNow;
}) {
  const { place, gpsLine, directionsUrl } = celebrationPlace(celebration, venues);
  // The GPS code stays on one line, so a phone never splits "AX-0084-3317".
  const notes = [gpsLine, celebration.placeDetail].filter((note): note is string => Boolean(note));
  const directions = (
    <TextLink href={directionsFrom(directionsUrl)} className="min-h-0! py-0.5! text-[11px]">
      Directions
    </TextLink>
  );
  const headingId = `${celebration.id}-name`;
  return (
    <section id={celebration.id} aria-labelledby={headingId} className="flex scroll-mt-20 flex-col gap-4 lg:scroll-mt-28 lg:gap-3.5">
      <div className="flex items-center gap-4 lg:items-end lg:justify-between lg:gap-5 lg:border-b lg:border-hairline lg:pb-3.5">
        <div aria-hidden className="w-16.5 flex-none rounded-md bg-blush py-2.5 text-center lg:hidden">
          <p className="m-0 text-[9.5px] uppercase tracking-[0.24em] text-mocha">{celebration.weekdayShort}</p>
          <p className="m-0 font-serif text-[34px] leading-[1.05] lining-nums">{celebration.day}</p>
          <p className="m-0 text-[9.5px] uppercase tracking-[0.24em] text-mocha">{celebration.month.slice(0, 3)}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5 lg:gap-1">
          <p className="m-0 hidden text-[11px] uppercase tracking-[0.24em] text-ember-ink lg:block">{longDate(celebration)}</p>
          <h2 id={headingId} className="m-0 font-serif text-[30px] leading-[1.1] font-normal italic lg:text-[40px]">
            <span className="sr-only">{longDate(celebration)}: </span>
            {celebration.name}
          </h2>
          <p className="m-0 text-[13px] leading-snug text-mocha lg:text-sm">
            {place}
            {notes.map((note) => (
              <span key={note} className="whitespace-nowrap">
                {" · "}
                {note}
              </span>
            ))}
          </p>
          {celebration.id === "reception" ? (
            <p className="m-0 mt-2 flex items-center gap-2.5 text-[13px] text-mocha lg:text-sm">
              <span className="relative size-8 flex-none overflow-hidden rounded-full bg-tile ring-1 ring-ember ring-offset-2 ring-offset-white">
                <Image src={mcPortrait} alt="" fill sizes="32px" className="object-cover" style={{ objectPosition: "center 25%" }} />
              </span>
              <span>
                Hosted by <span className="font-serif text-[17px] text-cocoa italic">International MC</span>
              </span>
            </p>
          ) : null}
          <div className="mt-0.5 lg:hidden">{directions}</div>
        </div>
        <div className="hidden flex-none lg:block">{directions}</div>
      </div>

      <ol className="relative m-0 list-none p-0 before:absolute before:top-2.5 before:bottom-2.5 before:left-[77px] before:w-px before:bg-hairline lg:before:top-3 lg:before:bottom-3 lg:before:left-[115px]">
        {items.map(({ item, index }) => {
          const state = stateOf(index, standing);
          return (
            <li
              key={`${index}-${item.title}`}
              aria-current={state === "now" ? "step" : undefined}
              className={`grid grid-cols-[62px_30px_minmax(0,1fr)] items-start py-[11px] lg:grid-cols-[100px_30px_minmax(0,1fr)] lg:py-3 ${state === "done" ? "opacity-55" : ""}`}
            >
              <span className="pt-1 text-[10.5px] uppercase tracking-[0.12em] text-mocha lg:pt-[5px] lg:text-[11px] lg:tracking-[0.14em]">
                {item.time ? formatClock(item.time) : null}
              </span>
              <span
                aria-hidden
                className={`relative z-1 mx-auto mt-1.5 size-[11px] rounded-full lg:mt-[7px] ${
                  state === "now"
                    ? "bg-ember shadow-[0_0_0_5px_var(--color-halo)]"
                    : state === "done"
                      ? "bg-mocha"
                      : "border border-mocha bg-white"
                }`}
              />
              <div className="flex min-w-0 flex-col">
                <p className={`m-0 font-serif text-[21px] leading-[1.2] lg:text-[23px] ${state === "now" ? "font-medium" : ""}`}>
                  {item.title}
                  {state === "done" ? <span className="sr-only"> (finished)</span> : null}
                </p>
                {item.note ? <p className="m-0 mt-0.5 text-[13px] leading-[1.4] text-mocha lg:text-sm">{item.note}</p> : null}
                {item.place ? <p className="m-0 mt-0.5 text-[13px] leading-[1.4] text-mocha lg:text-sm">{item.place}</p> : null}
                {state === "now" ? (
                  <p className="m-0 mt-1 text-[10px] uppercase tracking-[0.24em] text-ember-ink">Happening now</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
