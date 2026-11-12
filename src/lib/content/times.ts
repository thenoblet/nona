/** A 24-hour time like 14:30. */
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * True when a celebration's end is earlier than its start: it ends after midnight, on the next
 * day. Receptions often run past midnight. Only two real times count; an equal end is refused.
 */
export function endsNextDay(startTime: string | null | undefined, endTime: string | null | undefined): boolean {
  if (!startTime || !endTime || !TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) return false;
  return endTime < startTime;
}

/** "14:30" as guests read it, "2:30 PM"; "00:15" is "12:15 AM". Anything else is shown as typed. */
export function formatClock(time: string): string {
  if (!TIME_PATTERN.test(time)) return time;
  const [hour, minutes] = time.split(":").map(Number);
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}
