import "server-only";
import type { PgBoss } from "pg-boss";
import { getBoss } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { previewSlotId } from "./slots";
import { readLiveSiteImage } from "./store";

/*
 * Sending the media worker a link preview card to draw (media.card, Ruling CJ): after a save or a
 * restore of a preview slot, and after the RSVP card's words change. The job's data is the saved
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
 * the RSVP card again with the new words, when the couple changed its photo. While it shows the
 * built-in photo, the build-time card reads the words itself. Never throws.
 */
export async function redrawRsvpCard(jobQueue: JobQueue = getBoss): Promise<void> {
  try {
    const live = await readLiveSiteImage(previewSlotId("rsvp"));
    if (live) await sendCardJob(live.id, jobQueue);
  } catch (error) {
    console.error("[site-images] could not queue the RSVP card's redraw; the next save of its photo sends it:", describeError(error));
  }
}
