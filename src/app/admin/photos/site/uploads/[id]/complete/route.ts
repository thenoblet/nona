import { after } from "next/server";
import * as zod from "zod";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { MAX_PART_COUNT } from "@/lib/media/limits";
import { completeUpload } from "@/lib/media/uploads";
import { badRequest, notFound, refuseUnlessAdmin, siteUpload, unavailable, type SiteUploadContext } from "../../access";

const MAX_BODY_BYTES = 64 * 1024;
/** As a guest's complete (Ruling V): it finishes on the server within this, whatever the browser does. */
const COMPLETE_BUDGET_MILLISECONDS = 40_000;

const completeRequest = zod.object({
  parts: zod
    .array(zod.object({ partNumber: zod.number().int().min(1).max(10_000), etag: zod.string().max(256) }))
    .max(MAX_PART_COUNT),
});

/**
 * Completes a site photo's upload once R2's own list of its parts adds up to its size, and queues
 * the photo job after the answer: `{ mediaId, status: "uploaded" }`. The couple only; 404 for
 * anything that isn't one of the site's photos; 409 while parts are missing. A repeat answers
 * with the photo's status as it is.
 */
export async function POST(request: Request, { params }: SiteUploadContext) {
  const refused = await refuseUnlessAdmin();
  if (refused) return refused;
  const { id } = await params;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  if (!completeRequest.safeParse(body.value).success) return badRequest("Send the parts as { partNumber, etag }.");
  try {
    const upload = await siteUpload(id);
    if (!upload) return notFound();
    if (upload.status !== "uploading") return jsonResponse({ mediaId: upload.id, status: upload.status });
    const outcome = await completeUpload(upload, { signal: AbortSignal.timeout(COMPLETE_BUDGET_MILLISECONDS), defer: after });
    switch (outcome) {
      case "uploaded":
        return jsonResponse({ mediaId: upload.id, status: "uploaded" });
      case "incomplete":
        return errorResponse(409, "incomplete", "The photo hasn't all arrived yet.");
      case "missing":
      case "expired":
      case "invalid-parts":
      case "overfilled":
        return errorResponse(409, outcome, "The photo didn't arrive whole. Choose it again.");
    }
  } catch (error) {
    console.error("[admin] could not complete a site photo's upload:", describeError(error));
    return unavailable();
  }
}
