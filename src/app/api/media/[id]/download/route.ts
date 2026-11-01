import { after } from "next/server";
import { errorResponse, jsonResponse, NO_STORE } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { findDownloadable } from "@/lib/media/album";
import { DOWNLOAD_VARIANTS, planDownload, requestFullSizeJpeg, type DownloadVariant } from "@/lib/media/downloads";
import { DOWNLOAD_URL_SECONDS, presignDerivedDownload, presignGet } from "@/lib/storage/objects";
import { unavailable, viewerGuests } from "../../../uploads/access";

type MediaContext = { params: Promise<{ id: string }> };

/** How soon a phone waiting for a HEIC's JPEG asks again: a 12 MP one is made in about a second, a 200 MP one in about six. */
const JPEG_RETRY_SECONDS = 3;

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

/**
 * A single download (Task 15): `?variant=original | converted | jpeg`. It redirects (302) to a
 * 6-hour presigned link that downloads as NONA26-<celebration>-<short id>.<ext>; asked with
 * `Accept: application/json` (Save to Photos fetches the file itself), it answers `{ status:
 * "ready", url, filename }` instead.
 * - Without a variant: a video's phone version when it has one, else the original.
 * - `converted`: a video's H.264 conversion, else its clean copy; 409 not-ready while it has neither.
 * - `jpeg`: an iPhone photo's full-size JPEG. The first request sends media.jpeg after the response
 *   and answers 202 `{ status: "preparing" }` with Retry-After; the phone asks again.
 * Only ready, visible album moments: 404 for anything hidden, removed, deleted, not ready, or a
 * wish (every download re-checks). Anyone may download; a browser with a guest is limited by it
 * (100, then 2 a second). Never cached.
 */
export async function GET(request: Request, { params }: MediaContext) {
  const { id } = await params;
  const variantText = new URL(request.url).searchParams.get("variant");
  if (variantText !== null && !(DOWNLOAD_VARIANTS as readonly string[]).includes(variantText)) {
    return errorResponse(400, "bad-request", "That isn't a download the album offers.");
  }
  const variant = variantText as DownloadVariant | null;
  const viewer = await viewerGuests("download");
  if (!viewer.ok) return viewer.response;

  try {
    const item = await findDownloadable(id);
    if (!item) return errorResponse(404, "not-found");
    const plan = planDownload(item, variant);
    if (plan.status === "not-offered") return errorResponse(404, "not-found");
    if (plan.status === "not-ready") return errorResponse(409, "not-ready");
    if (plan.status === "preparing") {
      after(async () => {
        try {
          await requestFullSizeJpeg(item.id);
        } catch (error) {
          console.error(`[media] could not send ${item.id}'s JPEG job; the next ask will:`, describeError(error));
        }
      });
      return jsonResponse({ status: "preparing" }, 202, { "Retry-After": String(JPEG_RETRY_SECONDS) });
    }
    const url =
      plan.bucket === "private"
        ? await presignGet(plan.key, { filename: plan.filename, expiresInSeconds: DOWNLOAD_URL_SECONDS })
        : await presignDerivedDownload(plan.key, { filename: plan.filename, expiresInSeconds: DOWNLOAD_URL_SECONDS });
    if (wantsJson(request)) return jsonResponse({ status: "ready", url, filename: plan.filename });
    return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": NO_STORE } });
  } catch (error) {
    console.error("[media] could not answer a download:", describeError(error));
    return unavailable();
  }
}
