import { AdminAccessError, requireAdmin } from "@/lib/admin/access";
import { errorResponse } from "@/lib/http/json";
import { findUpload, type UploadRow } from "@/lib/media/rows";

/*
 * What the admin's site-photo upload routes share (Task 19). They live under /admin, which
 * Cloudflare Access covers (/admin*): /api/admin wouldn't be. Not a route itself.
 */

/** Null for the couple; the 403 to send for anyone else. */
export async function refuseUnlessAdmin(): Promise<Response | null> {
  try {
    await requireAdmin();
    return null;
  } catch (error) {
    if (error instanceof AdminAccessError) return errorResponse(403, "forbidden");
    throw error;
  }
}

/** One of the couple's site photos by its id; null for anything else (a guest's upload included). */
export async function siteUpload(mediaId: string): Promise<UploadRow | null> {
  const upload = await findUpload(mediaId);
  return upload?.purpose === "site" ? upload : null;
}

export const notFound = () => errorResponse(404, "not-found");
export const badRequest = (message: string) => errorResponse(400, "bad-request", message);
export const unavailable = () => errorResponse(503, "unavailable", "That didn't work. Try again in a moment.");

/** The [id] segment's context, as Next passes it to a route handler. */
export type SiteUploadContext = { params: Promise<{ id: string }> };
