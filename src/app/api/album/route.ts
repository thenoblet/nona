import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { listAlbum, listNewer } from "@/lib/media/album";
import { parseFilter } from "@/lib/media/album-item";
import { unavailable, viewerGuests } from "../uploads/access";

/**
 * The album's pages (Task 15): `?cursor=` for the page after one the phone has, `?newer=` for the
 * moments listed since a page's newest (the pill), and the filters `celebration`, `kind`
 * (photo | video) and `view=mine`. Answers `{ items, nextCursor, newestCursor }`, or for `newer`
 * `{ items, complete, newestCursor }` (`complete: false` past 60: the phone reads its first page
 * again). The browser's own items read as its own, and only it sees those not ready. Anyone may
 * read it; a browser with a guest is limited by it (100, then 2 a second). Never cached: it names a
 * browser's own uploads.
 */
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const filter = parseFilter(query);
  if (!filter) return errorResponse(400, "bad-request", "That filter isn't one the album has.");
  const viewer = await viewerGuests("album");
  if (!viewer.ok) return viewer.response;

  try {
    const newer = query.get("newer");
    if (newer !== null) {
      const page = await listNewer({ ...filter, viewerGuestIds: viewer.guestIds, since: newer });
      if (!page) return errorResponse(400, "bad-request", "That isn't a place in the album.");
      return jsonResponse(page);
    }
    return jsonResponse(await listAlbum({ ...filter, viewerGuestIds: viewer.guestIds, cursor: query.get("cursor") }));
  } catch (error) {
    console.error("[album] could not read a page:", describeError(error));
    return unavailable();
  }
}
