import { createElement } from "react";
import { render, toPlainText } from "react-email";
import { unwrapOutlookOnly } from "@/emails/components/OutlookOnly";
import RsvpConfirmation, { type ConfirmationCelebration } from "@/emails/rsvp-confirmation";
import { buildIcs, celebrationEvent, googleCalendarUrl } from "@/lib/calendar/ics";
import { celebrationPlace } from "@/lib/content/place";
import type { SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";

const SUBJECT = "Your reply to Noblet & Nancy";

/** Only a plain name is echoed back: the address is unverified, so a link must not ride along. */
function greetingName(fullName: string): string | null {
  // A period only ends an initial or suffix ("J. Doe", "Jr."), so "bit.ly" is not a name.
  const plain =
    fullName.length <= 60 && /^(?:[\p{L}\p{M}' -]|\.(?= |$))+$/u.test(fullName);
  return plain ? fullName : null;
}

/** "05" reads as "5"; a day the couple wrote some other way is shown as written. */
const dayOfMonth = (day: string) => (/^\d+$/.test(day) ? String(Number(day)) : day);

/** The ticket stub's day: "Sat", "05", "Dec". A day written some other way is shown as written. */
const stubFor = (weekday: string, day: string, month: string) => ({
  weekday: weekday.slice(0, 3),
  day: /^\d+$/.test(day) ? String(Number(day)).padStart(2, "0") : day,
  month: month.slice(0, 3),
});

/**
 * The confirmation email for a reply, rendered from the template in `src/emails`. The same reply
 * always renders the same bytes (the calendar file is stamped with the reply's time, and the
 * personal link is the reply's guest's, read from the database), so a retry under the same
 * idempotency key sends exactly what the first try did. `personalLink` shows only to a guest
 * coming to at least one celebration; without one (a reply sent before personal links) the email
 * is as it always was.
 */
export async function renderRsvpConfirmation(
  rsvp: RsvpRecord,
  content: SiteContent,
  siteUrl: string,
  personalLink: string | null = null,
): Promise<{ subject: string; text: string; html: string; ics: string | null }> {
  const answered = content.celebrations.filter(
    (celebration) => rsvp.answers[celebration.id],
  );
  const attending = answered.filter(
    (celebration) => rsvp.answers[celebration.id] === "yes",
  );
  const celebrations: ConfirmationCelebration[] = answered.map((celebration) => {
    const comingTo = rsvp.answers[celebration.id] === "yes";
    const { place, gpsLine } = celebrationPlace(celebration, content.venues);
    return {
      id: celebration.id,
      name: celebration.name,
      date: `${celebration.weekday} ${dayOfMonth(celebration.day)} ${celebration.month}`,
      stub: stubFor(celebration.weekday, celebration.day, celebration.month),
      time: celebration.time,
      place,
      gpsLine,
      placeDetail: celebration.placeDetail,
      attending: comingTo,
      googleCalendarUrl: comingTo
        ? googleCalendarUrl(celebrationEvent(celebration, content.venues, siteUrl))
        : null,
    };
  });

  const html = unwrapOutlookOnly(
    await render(
      createElement(RsvpConfirmation, {
        guestName: greetingName(rsvp.fullName),
        celebrations,
        siteUrl,
        personalLink,
      }),
    ),
  );
  const text = toPlainText(html, {
    selectors: [
      // The headings are the greeting and the celebrations' names: written as they are, not shouted.
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false, leadingLineBreaks: 2, trailingLineBreaks: 1 } },
      // The footer's link already reads as the address it goes to.
      { selector: "a[data-text-without-href=true]", format: "anchor", options: { ignoreHref: true } },
    ],
  });

  const ics =
    attending.length > 0
      ? buildIcs(
          attending.map((celebration) => celebrationEvent(celebration, content.venues, siteUrl)),
          new Date(rsvp.receivedAt),
        )
      : null;

  return { subject: SUBJECT, text, html, ics };
}
