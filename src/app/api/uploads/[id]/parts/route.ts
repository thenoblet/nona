import { after, connection } from "next/server";
import * as zod from "zod";
import { jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { MAX_PART_COUNT } from "@/lib/media/limits";
import {
  isVisibleUpload,
  listUploadParts,
  mayContinueUpload,
  presignUploadParts,
  readUploadsSwitch,
  uploadPartCount,
} from "@/lib/media/uploads";
import { MAX_PARTS_PER_PRESIGN } from "@/lib/storage/objects";
import {
  alreadyUploaded,
  badRequest,
  browserGuests,
  forbidden,
  ownedUpload,
  unavailable,
  uploadMissing,
  uploadsClosed,
  type UploadContext,
} from "../../access";

// Twenty part numbers.
const MAX_BODY_BYTES = 2 * 1024;

const presignRequest = zod.object({
  partNumbers: zod.array(zod.number().int().min(1).max(MAX_PART_COUNT)).min(1).max(MAX_PARTS_PER_PRESIGN),
});

/**
 * The parts R2 already holds for this browser's upload, `{ parts: [{ partNumber, etag, size }] }`,
 * so a phone carrying it on sends only the rest. An upload already finished lists every part.
 * 403 for an upload that isn't this browser's; 409 `upload-missing` for one that has expired, or
 * whose parts held more than it declared (then aborted and deleted).
 */
export async function GET(request: Request, { params }: UploadContext) {
  // Request time only: the build never touches the database.
  await connection();
  const { id } = await params;
  const guests = await browserGuests("presign");
  if (!guests.ok) return guests.response;

  try {
    const [upload, uploads] = await Promise.all([ownedUpload(id, guests.guestIds), readUploadsSwitch()]);
    if (!upload) return forbidden();
    if (upload.status === "uploading" && !mayContinueUpload(upload, uploads)) return uploadsClosed();
    const parts = await listUploadParts(upload, { signal: request.signal, defer: after });
    if (!parts) return uploadMissing();
    return jsonResponse({ parts });
  } catch (error) {
    console.error("[uploads] could not list an upload's parts:", describeError(error));
    return unavailable();
  }
}

/**
 * Presigned PUT URLs for 1 to 20 of this browser's upload's parts, `{ urls: [{ partNumber, url }] }`,
 * each valid for an hour (the phone asks again on a 403) and bound to its part's size (the upload's
 * own 8 or 16 MiB, the last part the remainder): R2 refuses a PUT of any other length, so no one can
 * store more than the upload declared. The phone's first call asks only for the parts it sends at
 * once, so a burst of starts signs little (Ruling AY). Body: `{ partNumbers }`. Reads only: the upload's row and the uploads
 * switch, then signs locally, with no write and no network call.
 */
export async function POST(request: Request, { params }: UploadContext) {
  const { id } = await params;
  const guests = await browserGuests("presign");
  if (!guests.ok) return guests.response;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = presignRequest.safeParse(body.value);
  if (!parsed.success) return badRequest(`Ask for 1 to ${MAX_PARTS_PER_PRESIGN} part numbers.`);

  try {
    const [upload, uploads] = await Promise.all([ownedUpload(id, guests.guestIds), readUploadsSwitch()]);
    if (!upload || !isVisibleUpload(upload)) return forbidden();
    if (upload.status !== "uploading") return alreadyUploaded();
    if (!mayContinueUpload(upload, uploads)) return uploadsClosed();
    const parts = uploadPartCount(upload);
    const partNumbers = [...new Set(parsed.data.partNumbers)];
    if (partNumbers.some((partNumber) => partNumber > parts)) {
      return badRequest(`This upload's parts run from 1 to ${parts}.`);
    }
    const urls = await presignUploadParts(upload, partNumbers);
    if (!urls) return uploadMissing();
    return jsonResponse({ urls });
  } catch (error) {
    console.error("[uploads] could not presign an upload's parts:", describeError(error));
    return unavailable();
  }
}
