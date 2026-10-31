import { after } from "next/server";
import * as zod from "zod";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { MAX_PART_COUNT } from "@/lib/media/limits";
import { completeUpload, isVisibleUpload, mayContinueUpload, readUploadsSwitch } from "@/lib/media/uploads";
import {
  badRequest,
  browserGuests,
  forbidden,
  ownedUpload,
  unavailable,
  uploadMissing,
  uploadsClosed,
  type UploadContext,
} from "../../access";

// A 2 GB video's 256 parts, each a part number and an ETag.
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The most the R2 calls of one complete may take together (ListParts, Complete, and HeadObject
 * only after NoSuchUpload), well inside Cloudflare's 100 s, on top of each call's own 15 s.
 */
const COMPLETE_BUDGET_MILLISECONDS = 40_000;

/**
 * Ruling V: once a complete starts, it finishes on the server, bounded by its budget alone and not
 * by the request's signal. A phone that goes to the background or closes the page after sending it
 * would otherwise abort it part-way, leaving every byte in R2 and the row `uploading`, which only
 * that phone could carry on. The other upload routes stop when their request does.
 */
function completeBudget(): AbortSignal {
  return AbortSignal.timeout(COMPLETE_BUDGET_MILLISECONDS);
}

const completeRequest = zod.object({
  parts: zod
    .array(zod.object({ partNumber: zod.number().int().min(1).max(10_000), etag: zod.string().max(256) }))
    .max(MAX_PART_COUNT),
});

/**
 * Completes this browser's upload, once R2's own list of its parts adds up to the declared size,
 * and answers `{ mediaId, status: "uploaded" }`: the phone shows "Added to the album" only then.
 * The item's processing is queued after the answer; if that fails, the worker's sweeper queues it.
 * Body: `{ parts }`, as the phone sent them; R2's list is what is joined.
 * - Parts missing: 409 `incomplete`, and nothing changes.
 * - Parts holding more than declared (the part URLs bind each size, so only if R2 let one through):
 *   the upload is aborted and its row deleted, 409 `size-mismatch`.
 * - Already completed (a repeat, or two at once): the same answer, with one job queued. One that
 *   processing has since made ready answers `ready`; one it failed answers `{ status: "failed",
 *   reason }`, so the phone shows the failure and its reason, never "Added".
 * - Removed by its uploader ("Remove my upload", or a Cancel that found it arrived): 409 `removed`.
 *   The phone, asked to send that file again, starts a new upload of it: the guest wants it back.
 * - Hidden by the couple, or deleted: 409 `hidden`, and the phone says it can't be added. A file
 *   picked again never gets round the couple's moderation by being "Added" here.
 * - Its row gone while R2 joined the parts: 404 `missing`, and nothing is queued. (A cancel never
 *   deletes the row of an upload R2 has joined, so this is a defence.)
 * - The upload gone with no original made (cancelled first, aborted or expired): 409 `upload-missing`.
 * - 403 for an upload that isn't this browser's, or an album upload past the 24 hours after a close.
 *
 * It runs to the end even if the phone drops meanwhile (Ruling V), within a 40 s budget.
 */
export async function POST(request: Request, { params }: UploadContext) {
  const { id } = await params;
  const guests = await browserGuests("complete");
  if (!guests.ok) return guests.response;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  if (!completeRequest.safeParse(body.value).success) return badRequest("Send the parts as { partNumber, etag }.");

  try {
    const [upload, uploads] = await Promise.all([ownedUpload(id, guests.guestIds), readUploadsSwitch()]);
    if (!upload) return forbidden();
    if (upload.removedByUploader) return errorResponse(409, "removed");
    if (!isVisibleUpload(upload)) return errorResponse(409, "hidden");
    if (upload.status === "failed") return jsonResponse({ mediaId: upload.id, status: "failed", reason: upload.failureReason });
    if (upload.status !== "uploading") return jsonResponse({ mediaId: upload.id, status: upload.status });
    if (!mayContinueUpload(upload, uploads)) return uploadsClosed();

    const outcome = await completeUpload(upload, { signal: completeBudget(), defer: after });
    switch (outcome) {
      case "uploaded":
        return jsonResponse({ mediaId: upload.id, status: "uploaded" });
      case "missing":
        // The row went while R2 joined the parts: nothing is queued (finishUpload logs the original).
        return errorResponse(404, "missing");
      case "incomplete":
        return errorResponse(
          409,
          "incomplete",
          "This file hasn't all arrived yet. Keep this page open and it will finish sending.",
        );
      case "invalid-parts":
        return errorResponse(409, "invalid-parts", "This file's pieces didn't fit together. Please send it again.");
      case "overfilled":
        return errorResponse(
          409,
          "size-mismatch",
          "This file didn't match the size it started with. Please choose it again.",
        );
      case "expired":
        return uploadMissing();
    }
  } catch (error) {
    console.error("[uploads] could not complete an upload:", describeError(error));
    return unavailable();
  }
}
