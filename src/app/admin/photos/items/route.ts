import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { listAdminAlbum } from "@/lib/media/admin-album";
import { parseAdminFilter } from "@/lib/media/admin-item";

/**
 * The admin album's next page (Task 17): the page renders the first on the server and asks here for
 * the rest, `?cursor=` with the page's own filter (show, celebration, kind, q). The couple only:
 * 403 for anyone else, 400 for a filter the admin doesn't offer. Never cached.
 */
export async function GET(request: Request) {
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) return errorResponse(403, "forbidden");
    throw error;
  }
  const query = new URL(request.url).searchParams;
  const filter = parseAdminFilter(query);
  if (!filter) return errorResponse(400, "bad-request", "That isn't a filter the album offers.");
  try {
    return jsonResponse(await listAdminAlbum({ filter, cursor: query.get("cursor") }));
  } catch (error) {
    console.error("[admin] could not read a page of the album:", describeError(error));
    return errorResponse(503, "unavailable", "That didn't load. Try again in a moment.");
  }
}
