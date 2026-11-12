import { wedding } from "@/content/wedding";

/**
 * The homepage has three versions and the date picks one:
 * - before: the invitation
 * - day: the wedding day (5 December, until 05:00 the next morning), photo sharing first
 * - after: the thank-you page with the full album
 */
export type Mode = "before" | "day" | "after";

const start = Date.parse(wedding.weekendStart);
const end = Date.parse(wedding.weekendEnd);

export function modeAt(now: Date): Mode {
  const time = now.getTime();
  if (time < start) return "before";
  if (time < end) return "day";
  return "after";
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
