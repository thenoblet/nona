import { connection } from "next/server";
import { jsonResponse } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { editorPhotoOf } from "@/lib/site-images/admin";
import { readSiteUpload } from "@/lib/site-images/store";
import { notFound, refuseUnlessAdmin, unavailable, type SiteUploadContext } from "../access";

/**
 * A site photo's processing, for the editor, which asks every couple of seconds after the upload:
 * `{ mediaId, status }` while the worker makes its sizes, `{ …, status: "ready", photo: { url,
 * width, height } }` once it has (the viewing size, on MEDIA_BASE_URL), or `{ …, status: "failed",
 * reason }`. The couple only; 404 for anything that isn't one of the site's photos. Never cached.
 */
export async function GET(_request: Request, { params }: SiteUploadContext) {
  await connection();
  const refused = await refuseUnlessAdmin();
  if (refused) return refused;
  const { id } = await params;
  try {
    const upload = await readSiteUpload(id);
    if (!upload) return notFound();
    if (upload.status === "failed") return jsonResponse({ mediaId: upload.id, status: "failed", reason: upload.failureReason });
    const photo = upload.status === "ready" ? editorPhotoOf(upload) : null;
    return jsonResponse(photo ? { mediaId: upload.id, status: "ready", photo } : { mediaId: upload.id, status: upload.status });
  } catch (error) {
    console.error("[admin] could not read a site photo's processing:", describeError(error));
    return unavailable();
  }
}
