import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { findAlbumItems, MAX_ITEMS_PER_READ } from "@/lib/media/album";
import { unavailable, viewerGuests } from "../uploads/access";

/**
 * Several moments at once, `{ items }`, as GET /api/media/[id] answers each (fix round 1, Important
 * #2): `?ids=<id>,<id>…`, at most 50. The album's own waiting tiles and the uploader's cards ask after
 * all of theirs in one request every few seconds, so an honest guest never runs into the limit. A
 * moment that isn't there (hidden, removed, someone else's not ready) is left out. One query on the
 * primary key; one request from the guest's `item` bucket however many it names. Never cached.
 */
export async function GET(request: Request) {
  const text = new URL(request.url).searchParams.get("ids") ?? "";
  const ids = text.split(",").filter((id) => id.length > 0);
  if (ids.length === 0 || ids.length > MAX_ITEMS_PER_READ) {
    return errorResponse(400, "bad-request", `Name from 1 to ${MAX_ITEMS_PER_READ} moments.`);
  }
  const viewer = await viewerGuests("item");
  if (!viewer.ok) return viewer.response;

  try {
    return jsonResponse({ items: await findAlbumItems(ids, viewer.guestIds) });
  } catch (error) {
    console.error("[media] could not read moments:", describeError(error));
    return unavailable();
  }
}
