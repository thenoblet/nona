import { after } from "next/server";
import * as zod from "zod";
import { cleanFilename } from "@/lib/data/text";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { checkUpload } from "@/lib/media/limits";
import { createUpload } from "@/lib/media/uploads";
import { badRequest, refuseUnlessAdmin, unavailable } from "./access";

const MAX_BODY_BYTES = 8 * 1024;

const startRequest = zod.object({
  filename: zod.string().max(1024),
  size: zod.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  contentType: zod.string().max(255),
});

/**
 * Starts the upload of one of the site's own photos (Task 19): the couple only, the only way a
 * `purpose: "site"` row is ever made (the guests' /api/uploads refuses it). The same presigned
 * multipart upload as a guest's (lib/media/uploads.ts), straight to R2 in 8 MiB parts, with no
 * guest: the photo job then makes its sizes, two more than an album photo's.
 * Body: `{ filename, size, contentType }`; a photo the album would take, up to 50 MB.
 * Answers `{ mediaId, uploadId, key, partSize, partCount, uploadedParts }`; then
 * ./[id]/parts for the part URLs and ./[id]/complete.
 */
export async function POST(request: Request) {
  const refused = await refuseUnlessAdmin();
  if (refused) return refused;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = startRequest.safeParse(body.value);
  if (!parsed.success) return badRequest("The photo's details aren't valid.");
  const { filename, size, contentType } = parsed.data;
  const checked = checkUpload({ purpose: "site", filename, contentType, size });
  if (!checked.ok) return errorResponse(400, checked.error, checked.message);
  try {
    const session = await createUpload(
      {
        purpose: "site",
        kind: checked.kind,
        guestId: null,
        uploaderName: null,
        originalFilename: cleanFilename(filename),
        sizeBytes: size,
        contentType: checked.contentType,
        extension: checked.extension,
        fingerprint: null,
        capturedAt: null,
      },
      { signal: request.signal, defer: after },
    );
    return jsonResponse(session);
  } catch (error) {
    console.error("[admin] could not start a site photo's upload:", describeError(error));
    return unavailable();
  }
}
