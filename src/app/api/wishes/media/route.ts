import { findOwnWishMedia, MAX_WISH_MEDIA_PER_READ } from "@/lib/data/wishes";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { unavailable, viewerGuests } from "../../uploads/access";

/**
 * The sender's "Getting your wish ready…" check (Ruling BU): `?ids=<mediaId>,…`, at most 50, answers
 * `{ items: [{ id, state }] }`, `state` being `processing`, `ready` or `failed`, for each recording
 * that is one of this browser's guests' own, linked to a wish on the wall (findOwnWishMedia). Every
 * other id (another guest's, hidden, deleted, an album item, an orphan, nonsense) is left out, the
 * same as one that doesn't exist; a browser with no guest gets none. The wall's pending cards ask
 * through Task 15's item-watch scheduler: one request a round for all of them, from the guest's
 * `item` bucket (never by IP). One query on the primary key. Never cached.
 */
export async function GET(request: Request) {
  const text = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = text.split(",").filter((id) => id.length > 0);
  if (ids.length === 0 || ids.length > MAX_WISH_MEDIA_PER_READ) {
    return errorResponse(400, "bad-request", `Name from 1 to ${MAX_WISH_MEDIA_PER_READ} recordings.`);
  }
  const viewer = await viewerGuests("item");
  if (!viewer.ok) return viewer.response;

  try {
    return jsonResponse({ items: await findOwnWishMedia(ids, viewer.guestIds) });
  } catch (error) {
    console.error("[wishes] could not read recordings:", describeError(error));
    return unavailable();
  }
}
