import exifr from "exifr";

/*
 * When a photo was taken, from its EXIF. The media worker reads it to group the photo under its
 * celebration (celebration.ts). EXIF's DateTimeOriginal is the camera's wall-clock time with no
 * zone; OffsetTimeOriginal (or OffsetTime) says which, when the phone wrote one. A time without an
 * offset is read as Accra's, which is UTC all year: the wedding's, so a guest's camera at home
 * time is the likeliest. No location or other tag is ever read.
 */

/** The EXIF tags a capture time comes from, as an EXIF reader gives them: raw text, or anything. */
export type ExifTimes = {
  DateTimeOriginal?: unknown;
  OffsetTimeOriginal?: unknown;
  OffsetTime?: unknown;
};

// "2026:12:05 10:30:00", as EXIF writes it; some software writes dashes or a T.
const EXIF_DATE_TIME = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
// "+02:00", "-05:30" or "Z".
const EXIF_OFFSET = /^(?:([+-])(\d{2}):(\d{2})|Z)$/;
const MINUTE_MS = 60_000;
/** The widest offsets in use: UTC−12:00 to UTC+14:00. */
const MOST_MINUTES_BEHIND = 12 * 60;
const MOST_MINUTES_AHEAD = 14 * 60;

/** The offset from UTC in minutes, or null when it is missing or makes no sense. */
function offsetMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parts = EXIF_OFFSET.exec(value.trim());
  if (!parts) return null;
  if (!parts[1]) return 0;
  const [hours, minutes] = [Number(parts[2]), Number(parts[3])];
  if (minutes >= 60) return null;
  const total = (parts[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
  return total < -MOST_MINUTES_BEHIND || total > MOST_MINUTES_AHEAD ? null : total;
}

/**
 * The moment a photo was taken: DateTimeOriginal at OffsetTimeOriginal, else at OffsetTime, else
 * in Accra (UTC). Null when there is no date, or it isn't one (a zeroed or impossible date).
 */
export function captureTimeFromExif(tags: ExifTimes): Date | null {
  if (typeof tags.DateTimeOriginal !== "string") return null;
  const parts = EXIF_DATE_TIME.exec(tags.DateTimeOriginal.trim());
  if (!parts) return null;
  const [year, month, day, hours, minutes, seconds] = parts.slice(1).map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hours, minutes, seconds);
  // Date.UTC rolls 30 February into March: a date that doesn't come back as written isn't one.
  const roundTrip = new Date(wallClock);
  const realDate =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hours &&
    roundTrip.getUTCMinutes() === minutes &&
    roundTrip.getUTCSeconds() === seconds;
  if (!realDate) return null;
  const offset = offsetMinutes(tags.OffsetTimeOriginal) ?? offsetMinutes(tags.OffsetTime) ?? 0;
  return new Date(wallClock - offset * MINUTE_MS);
}

/** No guest's photo was taken before this: an earlier time is a camera's reset clock (1970, 1980). */
const EARLIEST_CAPTURE = Date.UTC(2000, 0, 1);
/** How far past the upload's start a capture time may be: a phone's clock set a few hours ahead, or a wrong zone. */
const LATEST_AFTER_START_MS = 24 * 60 * 60 * 1000;

/**
 * The capture time, unless it can't be true: before 2000, or more than a day after the upload
 * started (a clock that is wrong, or was never set). Such a time counts as none, so the photo is
 * grouped by the next best: the phone's time, then the upload's.
 */
export function plausibleCaptureTime(capturedAt: Date | null, startedAt: Date): Date | null {
  if (!capturedAt) return null;
  const moment = capturedAt.getTime();
  if (Number.isNaN(moment) || moment < EARLIEST_CAPTURE || moment > startedAt.getTime() + LATEST_AFTER_START_MS) return null;
  return capturedAt;
}

/**
 * The capture time in a photo file's EXIF (JPEG, PNG, HEIC or TIFF), read without loading the
 * file: only the three tags above. Null when the file has none, or has no EXIF a reader knows
 * (WebP, GIF), or can't be read: a photo without a time is grouped by its upload time instead.
 */
export async function readPhotoCaptureTime(path: string): Promise<Date | null> {
  try {
    const tags: ExifTimes | undefined = await exifr.parse(path, {
      pick: ["DateTimeOriginal", "OffsetTimeOriginal", "OffsetTime"],
      // The raw text: exifr would otherwise read the zoneless time in this machine's zone.
      reviveValues: false,
    });
    return tags ? captureTimeFromExif(tags) : null;
  } catch {
    return null;
  }
}
