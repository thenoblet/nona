// Dates and times as the couple read them: in Accra. Ghana keeps GMT all year, with no daylight
// saving, so a day there is always 24 hours. Shared by the admin's replies, its CSV export and its
// "Site text" pages, and by the reply-by date guests see.

const ACCRA = "Africa/Accra";

const isoDay = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ACCRA });
const timeOfDay = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: ACCRA });
const dayAndMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: ACCRA });
const dayAndFullMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: ACCRA });
const dateAndTime = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: ACCRA,
});

/** "2026-10-30": the day in Accra. */
export function accraDate(moment: Date): string {
  return isoDay.format(moment);
}

/** "21:14" in Accra. */
export function accraTime(moment: Date): string {
  return timeOfDay.format(moment);
}

/** "30 Oct" in Accra. */
export function accraDayAndMonth(moment: Date): string {
  return dayAndMonth.format(moment);
}

/** "20 November" for the calendar day "2026-11-20". Accra keeps GMT, so midnight there is midnight UTC. */
export function accraDayAndFullMonth(day: string): string {
  return dayAndFullMonth.format(new Date(`${day}T00:00:00Z`));
}

/** "28 Oct, 18:02" in Accra, for an ISO time such as a reply's receivedAt. */
export function accraDateTime(iso: string): string {
  return dateAndTime.format(new Date(iso));
}
