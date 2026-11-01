import { connection } from "next/server";
import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { listAdminWishes } from "@/lib/media/admin-wishes";

/**
 * The admin Wishes tab's next page (Task 17), `?cursor=`. The couple only: 403 for anyone else.
 * Never cached.
 */
export async function GET(request: Request) {
  await connection();
  try {
    await requireAdmin();
  } catch (error) {
    if (error instanceof AdminAccessError) return errorResponse(403, "forbidden");
    throw error;
  }
  try {
    return jsonResponse(await listAdminWishes({ cursor: new URL(request.url).searchParams.get("cursor") }));
  } catch (error) {
    console.error("[admin] could not read a page of the wishes:", describeError(error));
    return errorResponse(503, "unavailable", "That didn't load. Try again in a moment.");
  }
}
