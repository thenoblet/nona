import { wedding } from "@/content/wedding";

/**
 * The homepage has three versions and the date picks one:
 * - before: the invitation
 * - day: the wedding weekend (5 and 6 December), photo sharing first
 * - after: the thank-you page with the full album
 */
export type Mode = "before" | "day" | "after";

const start = Date.parse(wedding.weekendStart);
const end = Date.parse(wedding.weekendEnd);
const DAY = 24 * 60 * 60 * 1000;

export function modeAt(now: Date): Mode {
  const t = now.getTime();
  if (t < start) return "before";
  if (t < end) return "day";
  return "after";
}

/** True on Sunday 6 December, so the schedule moves on to the thanksgiving service. */
export function isSecondDay(now: Date): boolean {
  const t = now.getTime();
  return t >= start + DAY && t < end;
}

const previewAllowed =
  process.env.NODE_ENV !== "production" || process.env.ALLOW_MODE_PREVIEW === "true";

/**
 * `?mode=day` or `?mode=after` previews another version.
 * Allowed in development, or in production when ALLOW_MODE_PREVIEW=true.
 */
export function resolveMode(now: Date, preview?: string | string[] | null): Mode {
  const value = Array.isArray(preview) ? preview[0] : preview;
  if (previewAllowed && (value === "before" || value === "day" || value === "after")) {
    return value;
  }
  return modeAt(now);
}
