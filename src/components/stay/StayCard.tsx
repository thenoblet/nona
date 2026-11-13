import { Icon } from "@/components/ui/Icon";
import { telHref } from "@/lib/content/phone";
import type { Stay } from "@/lib/content/schema";

const button =
  "press inline-flex min-h-12 items-center justify-center gap-2 rounded-full text-[11px] uppercase tracking-[0.18em] no-underline";

/**
 * One place to stay: its label, name, how far it is and the price, then Call and Directions. A place
 * without a phone or a map link leaves that button out, and the other fills the row.
 */
export function StayCard({ stay }: { stay: Stay }) {
  const callLabel = stay.phone ? `Call ${stay.name} on ${stay.phone}` : undefined;
  return (
    <article className="flex flex-col gap-3.5 rounded-md border border-hairline bg-white px-5 pt-5.5 pb-5 shadow-[0_10px_28px_rgb(61_41_39/0.07)] lg:px-6.5 lg:pt-7 lg:pb-6">
      {stay.tag ? (
        <p className="m-0 self-start rounded-full bg-halo px-2.5 py-1.5 text-[10px] uppercase tracking-[0.18em] text-ember-ink">{stay.tag}</p>
      ) : null}
      <h2 className="m-0 font-serif text-[28px] leading-[1.1] font-normal italic lg:min-h-[2.2em] lg:text-[30px]">{stay.name}</h2>
      <dl className="m-0 flex flex-col gap-2 border-y border-hairline py-3 text-sm leading-[1.4] text-mocha">
        <div className="flex items-center gap-2.5">
          <dt className="contents">
            <Icon name="pin" size={18} strokeWidth={1.7} className="shrink-0 text-ember" />
            <span className="sr-only">How far</span>
          </dt>
          <dd className="m-0">{stay.distance}</dd>
        </div>
        {stay.price ? (
          <div className="flex items-center gap-2.5">
            <dt className="contents">
              <Icon name="bed" size={18} strokeWidth={1.7} className="shrink-0 text-ember" />
              <span className="sr-only">Price</span>
            </dt>
            <dd className="m-0">{stay.price}</dd>
          </div>
        ) : null}
      </dl>
      {stay.phone || stay.mapsUrl ? (
        <div className="grid auto-cols-fr grid-flow-col gap-2.5">
          {stay.phone ? (
            <a href={telHref(stay.phone)} aria-label={callLabel} className={`${button} bg-cocoa text-white shadow-[var(--shadow-pill-cocoa)]`}>
              <Icon name="phone" size={16} />
              Call
            </a>
          ) : null}
          {stay.mapsUrl ? (
            <a
              href={stay.mapsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Directions to ${stay.name} (opens Google Maps)`}
              className={`${button} border border-cocoa bg-white text-cocoa`}
            >
              <Icon name="directions" size={16} />
              Directions
            </a>
          ) : null}
        </div>
      ) : null}
      {stay.phone || stay.note ? (
        <p className="m-0 text-center text-[13px] text-mocha lg:mt-auto">
          {stay.note && stay.phone ? `${stay.note}: ${stay.phone}` : (stay.note ?? stay.phone)}
        </p>
      ) : null}
    </article>
  );
}
