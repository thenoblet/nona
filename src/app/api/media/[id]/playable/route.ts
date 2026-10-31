import { after } from "next/server";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { playableVersion } from "@/lib/media/conversion";
import { browserGuests, unavailable } from "../../../uploads/access";

type MediaContext = { params: Promise<{ id: string }> };

/**
 * Asked by a guest's phone that can't play a video's original (the viewer's third choice): the
 * version every phone plays. Answers, never cached:
 * - `{ status: "ready", url }`: converted; the MP4 from the public bucket;
 * - `{ status: "preparing" }`: its conversion is on its way. The first ask marks the row
 *   (conversion_requested_at) and sends media.convert at priority 20, which the worker's on-demand
 *   conversions take at once, after the response; asking again sends nothing more;
 * - `{ status: "failed", reason }`: its conversion failed for good ("too-long", "corrupt"…), so
 *   there is none to wait for.
 * 404 for anything but a ready, visible album video (hidden, deleted, not ready, or no such id),
 * 403 for a browser with no guest. 429 with Retry-After past the guest's own `playable` limit (100,
 * then 2 a second), or, for a first ask, past its `conversion` bucket (10, then one a minute): the
 * phone waits and asks again.
 * One read on the primary key, and one update only for a first ask: no slow work here.
 */
export async function POST(_request: Request, { params }: MediaContext) {
  const { id } = await params;
  const guests = await browserGuests("playable");
  if (!guests.ok) return guests.response;
  const [ownGuestId] = guests.guestIds;

  try {
    const answer = await playableVersion(id, { defer: after, mayStart: () => takeToken(ownGuestId, "conversion") });
    if (!answer) return errorResponse(404, "not-found");
    if (answer.status === "limited") return rateLimitedResponse(answer.retryAfterSeconds);
    return jsonResponse(answer);
  } catch (error) {
    console.error("[media] could not answer a playable request:", describeError(error));
    return unavailable();
  }
}
