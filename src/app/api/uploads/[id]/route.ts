import { isUuid } from "@/lib/data/ids";
import { errorResponse, jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { findUpload } from "@/lib/media/rows";
import { cancelUpload } from "@/lib/media/uploads";
import { alreadyUploaded, browserGuests, forbidden, unavailable, type UploadContext } from "../access";

/**
 * Cancels this browser's unfinished upload when the guest taps "Cancel": aborts its multipart
 * upload and deletes its row, answering `{ mediaId, cancelled: true }`. Nothing else aborts
 * uploads (R2's 7-day rule clears abandoned ones), so a phone that loses its connection can always
 * carry on. 409 `already-uploaded` for a finished upload, including one a complete joined while
 * this ran (its row stays, so no original is ever left without one), which "Remove my upload"
 * hides instead; 403 for an upload that isn't this browser's; 404 for one that isn't there (already
 * cancelled, or never made), which the phone takes as done: a Cancel whose answer was lost, sent
 * again on the next visit, must be able to tell "gone" from "not yours".
 */
export async function DELETE(request: Request, { params }: UploadContext) {
  const { id } = await params;
  const guests = await browserGuests("complete");
  if (!guests.ok) return guests.response;

  try {
    const upload = isUuid(id) ? await findUpload(id) : null;
    if (!upload) return errorResponse(404, "not-found");
    if (!upload.guestId || !guests.guestIds.includes(upload.guestId)) return forbidden();
    if (upload.status !== "uploading") return alreadyUploaded();
    if (!(await cancelUpload(upload, { signal: request.signal }))) return alreadyUploaded();
    return jsonResponse({ mediaId: upload.id, cancelled: true });
  } catch (error) {
    console.error("[uploads] could not cancel an upload:", describeError(error));
    return unavailable();
  }
}
