import { Halo } from "@/components/ui/Halo";
import { Icon } from "@/components/ui/Icon";
import { telHref, whatsappHref } from "@/lib/content/phone";
import type { Helper } from "@/lib/content/schema";

/**
 * Who guests can call or WhatsApp for help on the day: finding their way to Tepa, the church or the
 * reception, or anything else, since the couple won't have their phones. The helpers are the
 * couple's (Site text, Help on the day); with none, there is no card.
 */
export function HelpCard({
  helpers,
  heading = "Need a hand?",
  className = "",
}: {
  helpers: Helper[];
  heading?: string;
  className?: string;
}) {
  if (helpers.length === 0) return null;
  return (
    <section
      id="help"
      aria-labelledby="help-h"
      className={`flex flex-col gap-4 rounded-[var(--radius-paper)] bg-white px-5 pt-6 pb-3 text-left shadow-[0_1px_2px_rgb(61_41_39/0.06),0_14px_32px_rgb(61_41_39/0.1)] ${className}`}
    >
      <div className="flex items-start gap-3.5">
        <Halo icon="phone" size="md" />
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="help-h" className="m-0 font-serif text-[26px] leading-tight font-normal italic">
            {heading}
          </h2>
          <p className="m-0 text-[14.5px] leading-[1.6] text-mocha">
            Finding your way to Tepa, the church or the reception, or anything else on the day: call or WhatsApp one of
            these friends. Noblet and Nancy will be away from their phones.
          </p>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {helpers.map((helper) => (
          <li key={`${helper.name} ${helper.phone}`} className="flex items-center gap-2.5 border-t border-hairline py-3">
            <span className="flex min-w-0 flex-1 flex-col">
              {/* A long name wraps rather than losing its end on a small phone. */}
              <span className="font-serif text-[20px] leading-tight [overflow-wrap:anywhere] italic">{helper.name}</span>
              <span className="text-[12px] tracking-[0.08em] text-mocha">{helper.phone}</span>
              {helper.note ? <span className="text-[12.5px] leading-snug text-mocha">{helper.note}</span> : null}
            </span>
            <a
              href={whatsappHref(helper.phone)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`WhatsApp ${helper.name}`}
              className="press flex size-11 shrink-0 items-center justify-center rounded-full border border-stone text-cocoa no-underline transition-colors hover:border-cocoa"
            >
              <Icon name="chat" size={18} />
            </a>
            <a
              href={telHref(helper.phone)}
              aria-label={`Call ${helper.name}, ${helper.phone}`}
              className="press flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full bg-cocoa px-4 text-[11px] uppercase tracking-[0.18em] text-white no-underline max-[359px]:px-0"
            >
              <Icon name="phone" size={15} className="text-ember" />
              {/* Under 360 px wide the pill is a round button, so the name keeps its room. */}
              <span aria-hidden className="max-[359px]:hidden">
                Call
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
