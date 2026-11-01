import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { findAlbumItem } from "@/lib/media/album";
import { unavailable, viewerGuests } from "../../uploads/access";

type MediaContext = { params: Promise<{ id: string }> };

/**
 * One moment, `{ item }`, as the album has it (Task 15): what the viewer asks every 10 s while a
 * video's phone version is made, and the uploader once a file is added, for the server's thumbnail
 * of one the phone couldn't draw (Ruling BB). A listed, visible album moment for anyone; the
 * browser's own while it is made ready or after it failed, so that shows. 404 for anything else
 * (hidden, removed, deleted, a wish, someone else's not ready). A browser with a guest is limited
 * by it (100, then 2 a second). Never cached.
 */
export async function GET(_request: Request, { params }: MediaContext) {
  const { id } = await params;
  const viewer = await viewerGuests("item");
  if (!viewer.ok) return viewer.response;

  try {
    const item = await findAlbumItem(id, viewer.guestIds);
    if (!item) return errorResponse(404, "not-found");
    return jsonResponse({ item });
  } catch (error) {
    console.error("[media] could not read a moment:", describeError(error));
    return unavailable();
  }
}
