import "server-only";
import { getSetting, setSetting } from "@/lib/data/settings";

/*
 * The venue TV's delay (Noblet, 30 Oct; Task 17): a moment reaches the slideshow only this many
 * seconds after it is listed, so the couple can hide anything first. The admin saves it as the
 * `slideshow_delay_seconds` setting; until then SLIDESHOW_DELAY_SECONDS (read at request time,
 * 180 when it isn't set) applies. Task 20's slides read getSlideshowDelaySeconds().
 */

export const SLIDESHOW_DELAY_MAX_SECONDS = 900;
/** The delay while neither the admin nor SLIDESHOW_DELAY_SECONDS sets one: three minutes. */
export const SLIDESHOW_DELAY_DEFAULT_SECONDS = 180;

/** Whether the value is a delay the TV takes: whole seconds from 0 to 900. */
export function isSlideshowDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= SLIDESHOW_DELAY_MAX_SECONDS;
}

/** SLIDESHOW_DELAY_SECONDS, or 180 when it isn't set or isn't whole seconds from 0 to 900. */
export function environmentSlideshowDelaySeconds(env: Record<string, string | undefined> = process.env): number {
  const text = env.SLIDESHOW_DELAY_SECONDS?.trim() ?? "";
  if (!/^\d{1,4}$/.test(text)) return SLIDESHOW_DELAY_DEFAULT_SECONDS;
  const seconds = Number(text);
  return isSlideshowDelay(seconds) ? seconds : SLIDESHOW_DELAY_DEFAULT_SECONDS;
}

/** The TV delay, whether the admin saved it, and the environment's, which applies while they haven't. */
export type SlideshowDelay = { seconds: number; saved: boolean; defaultSeconds: number };

/** The TV delay as the admin shows it, in one query. A saved value that isn't a delay counts as none. */
export async function readSlideshowDelay(): Promise<SlideshowDelay> {
  const defaultSeconds = environmentSlideshowDelaySeconds();
  const saved = await getSetting("slideshow_delay_seconds", null);
  return isSlideshowDelay(saved) ? { seconds: saved, saved: true, defaultSeconds } : { seconds: defaultSeconds, saved: false, defaultSeconds };
}

/** How many seconds after it is listed a moment may reach the venue TV (Task 20). */
export async function getSlideshowDelaySeconds(): Promise<number> {
  return (await readSlideshowDelay()).seconds;
}

/** Saves the admin's TV delay. Throws for anything but whole seconds from 0 to 900. */
export async function saveSlideshowDelaySeconds(seconds: number): Promise<void> {
  if (!isSlideshowDelay(seconds)) throw new RangeError(`Refusing ${JSON.stringify(seconds)} as the TV delay`);
  await setSetting("slideshow_delay_seconds", seconds);
}
