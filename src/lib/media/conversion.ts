import type { PgBoss } from "pg-boss";
import { isUuid } from "@/lib/data/ids";
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

/** A media.convert job's data: the video, and the lease it carries on when it is a held job's copy. */
export type ConvertJobData = { mediaId: string; leaseJobId?: string };

/**
 * The lease a media.convert job claims and carries on a conversion under (Ruling AQ): its own id,
 * which pg-boss keeps across its retries, or the held job's whose copy it is (`leaseJobId`).
 */
export function conversionLeaseOf(job: { id: string; data: Record<string, unknown> }): string {
  const leaseJobId = job.data.leaseJobId;
  return typeof leaseJobId === "string" && isUuid(leaseJobId) ? leaseJobId : job.id;
}

/**
 * Sends the video's conversion job, media.convert `{ mediaId }`, at `priority`: CONVERT_PRIORITY
 * .onDemand when a guest's phone asked for it or the couple made it a highlight (Task 12's
 * setHighlight), .backlog otherwise. Mark the row first (`queued`, and conversion_requested_at or
 * highlight for on demand), so that if this send fails, the sweeper sends it from the row within 15
 * minutes, at the same priority. A job sent twice is harmless: the second does nothing once the
 * conversion is done or claimed by the first (Ruling AG, AQ). Throws when the queue refuses the send.
 */
export async function requestConversion(
  mediaId: string,
  priority: ConvertPriority,
  jobQueue: () => Promise<Pick<PgBoss, "send">> = () => getBoss(),
): Promise<void> {
  const queue = await jobQueue();
  const data: ConvertJobData = { mediaId };
  await queue.send(MEDIA_QUEUES.convert, data, { priority });
}

/** What a phone that can't play a video's original is told (POST /api/media/[id]/playable). */
export type PlayableAnswer =
  /** The converted MP4, from the public bucket. */
  | { status: "ready"; url: string }
  /** Being made: the phone shows the poster and "Preparing a version for your phone…", and checks back. */
  | { status: "preparing" }
  /**
   * Its conversion failed for good, so there is none to wait for: "too-long" (past the worker's
   * WORKER_CONVERT_MAX_SECONDS), or why its job failed ("corrupt", "processing-failed"…). Task 15
   * words it, and offers the original.
   */
  | { status: "failed"; reason: string };

/** Whether the guest may start one more conversion: a takeToken result. */
export type ConversionAllowance = () => { allowed: boolean; retryAfterSeconds: number };

/**
 * The playable version of a ready, visible album video, or null when there is no such video
 * (hidden, deleted, not ready yet, a photo, a wish, or no such id). Converted, its URL. Otherwise
 * its conversion is asked for on demand: the first ask, if `mayStart` allows it (a guest's small
 * bucket of conversions, so no one can push the whole album onto the on-demand queue), marks the
 * row and sends the job at priority 20, after the response (`defer`); a repeated ask spends
 * nothing and sends nothing more, the row being the guard (markConversionRequested). A backlog job
 * already waiting for it may stay: it does nothing once the on-demand one has claimed it. One read
 * on the primary key, and an update only for a first ask.
 */
export async function playableVersion(
  mediaId: string,
  options: { defer: Defer; mayStart: ConversionAllowance },
): Promise<PlayableAnswer | { status: "limited"; retryAfterSeconds: number } | null> {
  const video = await findPlayableVideo(mediaId);
  if (!video) return null;
  if (video.conversion === "done" && video.videoKey) return { status: "ready", url: publicUrl(video.videoKey) };
  if (video.conversion === "done" || video.conversion === "failed") {
    return { status: "failed", reason: video.failureReason ?? "conversion-failed" };
  }
  if (video.requestedAt !== null) return { status: "preparing" };
  const allowance = options.mayStart();
  if (!allowance.allowed) return { status: "limited", retryAfterSeconds: allowance.retryAfterSeconds };
  if (await markConversionRequested(mediaId)) {
    options.defer(async () => {
      try {
        await requestConversion(mediaId, CONVERT_PRIORITY.onDemand);
      } catch (error) {
        console.error(`[media] could not send ${mediaId}'s conversion on demand; the sweeper will:`, describeError(error));
      }
    });
  }
  return { status: "preparing" };
}
