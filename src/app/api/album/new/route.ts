import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { countNewSince } from "@/lib/media/album";
import { parseFilter } from "@/lib/media/album-item";
import { unavailable, viewerGuests } from "../../uploads/access";

/**
 * The album's new-moments check (Task 15), asked every 30 s while the page is visible: how many
 * moments the page's filters hold that were listed after `?since=` (its newestCursor), at most 500,
 * and the newest three's thumbnails, `{ count, newest }`. One indexed query. Anyone may ask; a
 * browser with a guest is limited by it. Never cached.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const filter = parseFilter(query);
  const since = query.get("since");
  if (!filter || !since) return errorResponse(400, "bad-request", "Say since when, with a filter the album has.");
  const viewer = await viewerGuests("album");
  if (!viewer.ok) return viewer.response;

  try {
    const counted = await countNewSince(since, filter, viewer.guestIds);
    if (!counted) return errorResponse(400, "bad-request", "That isn't a place in the album.");
    return jsonResponse(counted);
  } catch (error) {
    console.error("[album] could not count the new moments:", describeError(error));
    return unavailable();
  }
}
