import { jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { cancelUpload } from "@/lib/media/uploads";
import {
  alreadyUploaded,
  browserGuests,
  forbidden,
  ownedUpload,
  unavailable,
  type UploadContext,
} from "../access";

/**
 * Cancels this browser's unfinished upload when the guest taps "Cancel": aborts its multipart
 * upload and deletes its row, answering `{ mediaId, cancelled: true }`. Nothing else aborts
 * uploads (R2's 7-day rule clears abandoned ones), so a phone that loses its connection can always
 * carry on. 409 `already-uploaded` for a finished upload, which "Remove my upload" hides instead;
 * 403 for an upload that isn't this browser's.
 */
export async function DELETE(request: Request, { params }: UploadContext) {
  const { id } = await params;
  const guests = await browserGuests("complete");
  if (!guests.ok) return guests.response;

  try {
    const upload = await ownedUpload(id, guests.guestIds);
    if (!upload) return forbidden();
    if (upload.status !== "uploading") return alreadyUploaded();
    if (!(await cancelUpload(upload, { signal: request.signal }))) return alreadyUploaded();
    return jsonResponse({ mediaId: upload.id, cancelled: true });
  } catch (error) {
    console.error("[uploads] could not cancel an upload:", describeError(error));
    return unavailable();
  }
}
