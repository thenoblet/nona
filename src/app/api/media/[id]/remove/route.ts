import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { ALBUM_SLIDES_TAG, hideMedia } from "@/lib/media/moderation";
import { browserGuests, forbidden, unavailable } from "../../../uploads/access";

type MediaContext = { params: Promise<{ id: string }> };

/**
 * How long the follow-ups after the response (the manifest's R2 PUT, the withdrawal's job) may take
 * together, beside each R2 call's own 15 s deadline.
 */
const FOLLOW_UP_BUDGET_MILLISECONDS = 30_000;

/**
 * "Remove my upload": hides one of this browser's guests' own items, `{ mediaId, removed: true }`.
 * It leaves every list, presign, download and the slideshow at once; then, after the response, its
 * manifest is written and the worker deletes its public files and purges them from Cloudflare
 * (moderation.ts). The album's and the slideshow's cache is dropped. Asking again answers the same.
 * The uploader calls it when a Cancel finds the file already arrived (409 already-uploaded), and
 * the viewer's own Remove (Task 15) does too.
 * - Owner only, against every guest the browser's cookie holds: 403 for another guest's item, an
 *   item no guest uploaded, or a browser without a guest; 404 for no such item.
 * - Limited per browser by its own guest, in the bucket its cancels use (100, then 2 a second).
 * Never cached.
 */
export async function POST(_request: Request, { params }: MediaContext) {
  const { id } = await params;
  const guests = await browserGuests("complete");
  if (!guests.ok) return guests.response;

  try {
    const removed = await hideMedia(
      id,
      { guestIds: guests.guestIds },
      // A budget of its own, never the request's signal: Next aborts that once the response is
      // sent, which is when after() runs the follow-ups.
      { defer: after, signal: AbortSignal.timeout(FOLLOW_UP_BUDGET_MILLISECONDS) },
    );
    if (!removed.ok) return removed.reason === "not-owner" ? forbidden() : errorResponse(404, "not-found");
    revalidateTag(ALBUM_SLIDES_TAG, { expire: 0 });
    return jsonResponse({ mediaId: id, removed: true });
  } catch (error) {
    console.error("[media] could not remove an upload:", describeError(error));
    return unavailable();
  }
}
