import { createElement } from "react";
import { render, toPlainText } from "react-email";
import { unwrapOutlookOnly } from "@/emails/components/OutlookOnly";
import RsvpConfirmation, { type ConfirmationCelebration } from "@/emails/rsvp-confirmation";
import { buildIcs, celebrationEvent, googleCalendarUrl } from "@/lib/calendar/ics";
import { celebrationPlace } from "@/lib/content/place";
import type { SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";
import { plainName } from "@/lib/rsvp/normalize";

const SUBJECT = "Your reply to Noblet & Nancy";

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
    const { place, gps } = celebrationPlace(celebration, content.venues);
    return {
      id: celebration.id,
      name: celebration.name,
      date: `${celebration.weekday} ${dayOfMonth(celebration.day)} ${celebration.month}`,
      stub: stubFor(celebration.weekday, celebration.day, celebration.month),
      time: celebration.time,
      place,
      gps,
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
        // Only a plain name is echoed back: the address is unverified, so a link must not ride along.
        guestName: plainName(rsvp.fullName),
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
