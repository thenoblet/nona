import * as zod from "zod";
import { jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { MAX_PART_COUNT } from "@/lib/media/limits";
import { presignUploadParts, uploadPartCount } from "@/lib/media/uploads";
import { MAX_PARTS_PER_PRESIGN } from "@/lib/storage/objects";
import { badRequest, notFound, refuseUnlessAdmin, siteUpload, unavailable, type SiteUploadContext } from "../../access";

const MAX_BODY_BYTES = 2 * 1024;

const presignRequest = zod.object({
  partNumbers: zod.array(zod.number().int().min(1).max(MAX_PART_COUNT)).min(1).max(MAX_PARTS_PER_PRESIGN),
});

/**
 * Presigned PUT URLs for 1 to 20 of a site photo's parts, `{ urls: [{ partNumber, url }] }`, each
 * valid for an hour and bound to its part's size, as a guest's are. The couple only; 404 for
 * anything that isn't an unfinished site photo. Reads its row, then signs locally: no network.
 */
export async function POST(request: Request, { params }: SiteUploadContext) {
  const refused = await refuseUnlessAdmin();
  if (refused) return refused;
  const { id } = await params;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = presignRequest.safeParse(body.value);
  if (!parsed.success) return badRequest(`Ask for 1 to ${MAX_PARTS_PER_PRESIGN} part numbers.`);
  try {
    const upload = await siteUpload(id);
    if (!upload || upload.status !== "uploading") return notFound();
    const partNumbers = [...new Set(parsed.data.partNumbers)];
    if (partNumbers.some((partNumber) => partNumber > uploadPartCount(upload))) {
      return badRequest(`This photo's parts run from 1 to ${uploadPartCount(upload)}.`);
    }
    const urls = await presignUploadParts(upload, partNumbers);
    if (!urls) return notFound();
    return jsonResponse({ urls });
  } catch (error) {
    console.error("[admin] could not presign a site photo's parts:", describeError(error));
    return unavailable();
  }
}
