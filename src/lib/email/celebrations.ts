import type { ConfirmationCelebration } from "@/emails/components/CelebrationCard";
import { celebrationEvent, googleCalendarUrl } from "@/lib/calendar/ics";
import { celebrationPlace } from "@/lib/content/place";
import type { SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";

// Without the email renderer, so the admin's pages can use it too.

/** "05" reads as "5"; a day the couple wrote some other way is shown as written. */
export const dayOfMonth = (day: string) => (/^\d+$/.test(day) ? String(Number(day)) : day);

/** The ticket stub's day: "Sat", "05", "Dec". A day written some other way is shown as written. */
const stubFor = (weekday: string, day: string, month: string) => ({
  weekday: weekday.slice(0, 3),
  day: /^\d+$/.test(day) ? String(Number(day)).padStart(2, "0") : day,
  month: month.slice(0, 3),
});

/**
 * The reply's answered celebrations as the emails' ticket cards, in the site's order: date, time,
 * place, and for the ones the guest is coming to, a Google Calendar link.
 */
export function emailCelebrations(rsvp: Pick<RsvpRecord, "answers">, content: SiteContent, siteUrl: string): ConfirmationCelebration[] {
  const answered = content.celebrations.filter((celebration) => rsvp.answers[celebration.id]);
  return answered.map((celebration) => {
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
}
