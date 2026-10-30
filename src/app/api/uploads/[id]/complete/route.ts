import { after } from "next/server";
import * as zod from "zod";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { MAX_PART_COUNT } from "@/lib/media/limits";
import { completeUpload, mayContinueUpload, readUploadsSwitch } from "@/lib/media/uploads";
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
 * - Already completed (a repeat, or two at once): the same answer, with one job queued.
 * - 403 for an upload that isn't this browser's, or an album upload past the 24 hours after a close.
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
    if (upload.status !== "uploading") return jsonResponse({ mediaId: upload.id, status: upload.status });
    if (!mayContinueUpload(upload, uploads)) return uploadsClosed();

    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(COMPLETE_BUDGET_MILLISECONDS)]);
    const outcome = await completeUpload(upload, { signal, defer: after });
    switch (outcome) {
      case "uploaded":
        return jsonResponse({ mediaId: upload.id, status: "uploaded" });
      case "incomplete":
        return errorResponse(
          409,
          "incomplete",
          "This file hasn't all arrived yet. Keep this page open and it will finish sending.",
        );
      case "invalid-parts":
        return errorResponse(409, "invalid-parts", "This file's pieces didn't fit together. Please send it again.");
      case "missing":
        return uploadMissing();
    }
  } catch (error) {
    console.error("[uploads] could not complete an upload:", describeError(error));
    return unavailable();
  }
}
