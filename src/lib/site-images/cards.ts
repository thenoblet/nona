import "server-only";
import type { PgBoss } from "pg-boss";
import { getBoss } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { previewPhotos } from "@/content/preview-photos";
import { focalFromPosition } from "./focal";
import { previewSlotId } from "./slots";
import { saveSiteImageUnlessSaved } from "./store";

/*
 * Sending the media worker a link preview card to draw (media.card, Ruling CJ): after a save or a
 * restore of a preview slot, and after the RSVP card's words change. The web server never draws one. The job's data is the saved
 * row's id only; the worker draws only a slot's live row, so a job for an older one does nothing.
 * Sent after the response (in after()), never in the request's way: a send that fails is logged,
 * and the card stays as it was until the next save.
 */

export type CardJobData = { siteImageId: string };

type JobQueue = () => Promise<Pick<PgBoss, "send">>;

/** Sends the row's card to the worker. Throws when the queue refuses. */
export async function sendCardJob(siteImageId: string, jobQueue: JobQueue = getBoss): Promise<void> {
  const data: CardJobData = { siteImageId };
  await (await jobQueue()).send(MEDIA_QUEUES.card, data);
}

/** The same, logging rather than throwing: for after(). */
export async function sendCardJobOrLog(siteImageId: string, jobQueue: JobQueue = getBoss): Promise<void> {
  try {
    await sendCardJob(siteImageId, jobQueue);
  } catch (error) {
    console.error(`[site-images] could not queue the card for site-image=${siteImageId}; the next save sends it:`, describeError(error));
  }
}

/**
 * After the RSVP settings change (the reply-by date, or replies opened or closed): the worker draws
 * the RSVP card again with the new words. The build-time card has the built-in date, so a slot still
 * on its built-in photo first gets a row of its own (the built-in photo, alt text and focal point,
 * saved by `savedBy`), and the page's og:image points at the worker's card once it is drawn. A slot
 * with a live row (the couple's photo, or their edit of the built-in) has it drawn again. Never
 * throws: a failure is logged, and the next settings change or save of the card's photo tries again.
 */
export async function redrawRsvpCard(savedBy: string, jobQueue: JobQueue = getBoss): Promise<void> {
  const slot = previewSlotId("rsvp");
  try {
    // The built-in row only if the slot has none: decided under the slot's lock, so the couple's own
    // photo, saved at the same moment, is never overtaken by it.
    const builtin = previewPhotos.rsvp;
    const live = await saveSiteImageUnlessSaved({
      slot,
      mediaId: null,
      alt: builtin.alt,
      focal: focalFromPosition(builtin.position),
      savedBy,
    });
    await sendCardJob(live.id, jobQueue);
  } catch (error) {
    console.error("[site-images] could not queue the RSVP card's redraw; the next settings change sends it:", describeError(error));
  }
}
