import type { PgBoss } from "pg-boss";
import { getBoss } from "@/lib/jobs/boss";
import { CONVERT_PRIORITY, MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { describeError } from "@/lib/log-error";
import { publicUrl } from "@/lib/storage/keys";
import type { Defer } from "./completion";
import { findPlayableVideo, markConversionRequested } from "./rows";

/*
 * Asking for a video's conversion, the version every phone plays (H.264 within 1080p, made by the
 * media worker's media.convert). The worker bundles this file too (the poster job sends the
 * backlog's conversions through it), so it reaches nothing from next/.
 */

/** A conversion's priority: `onDemand` (20) is taken at once, the backlog (below 20) while its switch is on. */
export type ConvertPriority = (typeof CONVERT_PRIORITY)[keyof typeof CONVERT_PRIORITY];

/**
 * Sends the video's conversion job, media.convert `{ mediaId }`, at `priority`: CONVERT_PRIORITY
 * .onDemand when a guest's phone asked for it or the couple made it a highlight (Task 12's
 * setHighlight), .backlog otherwise. Mark the row first (`queued`, and conversion_requested_at or
 * highlight for on demand), so that if this send fails, the sweeper sends it from the row within 15
 * minutes, at the same priority. A job sent twice is harmless: the second does nothing once the
 * conversion is done (Ruling AG). Throws when the queue refuses the send.
 */
export async function requestConversion(
  mediaId: string,
  priority: ConvertPriority,
  jobQueue: () => Promise<Pick<PgBoss, "send">> = () => getBoss(),
): Promise<void> {
  const queue = await jobQueue();
  await queue.send(MEDIA_QUEUES.convert, { mediaId }, { priority });
}

/** What a phone that can't play a video's original is told (POST /api/media/[id]/playable). */
export type PlayableAnswer =
  /** The converted MP4, from the public bucket. */
  | { status: "ready"; url: string }
  /** Being made: the phone shows the poster and "Preparing a version for your phone…", and checks back. */
  | { status: "preparing" }
  /** Its conversion failed for good: there is no version to wait for. */
  | { status: "failed" };

/**
 * The playable version of a ready, visible album video, or null when there is no such video
 * (hidden, deleted, not ready yet, a photo, a wish, or no such id). Converted, its URL. Otherwise
 * its conversion is asked for on demand: the first ask marks the row and sends the job at priority
 * 20, after the response (`defer`); a repeated ask sends nothing more, the row being the guard
 * (markConversionRequested). A backlog job already waiting for it may stay: it does nothing once
 * the on-demand one is done. One read on the primary key, and an update only when not converted.
 */
export async function playableVersion(mediaId: string, defer: Defer): Promise<PlayableAnswer | null> {
  const video = await findPlayableVideo(mediaId);
  if (!video) return null;
  if (video.conversion === "done") return video.videoKey ? { status: "ready", url: publicUrl(video.videoKey) } : { status: "failed" };
  if (video.conversion === "failed") return { status: "failed" };
  if (await markConversionRequested(mediaId)) {
    defer(async () => {
      try {
        await requestConversion(mediaId, CONVERT_PRIORITY.onDemand);
      } catch (error) {
        console.error(`[media] could not send ${mediaId}'s conversion on demand; the sweeper will:`, describeError(error));
      }
    });
  }
  return { status: "preparing" };
}
