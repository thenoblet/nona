import { after } from "next/server";
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
 * - `{ status: "failed" }`: its conversion failed for good, so there is none to wait for.
 * 404 for anything but a ready, visible album video (hidden, deleted, not ready, or no such id),
 * 403 for a browser with no guest, 429 past the guest's own `playable` limit (100, then 2 a second).
 * One read on the primary key, and one update only when it isn't converted: no slow work here.
 */
export async function POST(_request: Request, { params }: MediaContext) {
  const { id } = await params;
  const guests = await browserGuests("playable");
  if (!guests.ok) return guests.response;

  try {
    const answer = await playableVersion(id, after);
    if (!answer) return errorResponse(404, "not-found");
    return jsonResponse(answer);
  } catch (error) {
    console.error("[media] could not answer a playable request:", describeError(error));
    return unavailable();
  }
}
