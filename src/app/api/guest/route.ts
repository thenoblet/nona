import * as zod from "zod";
import { ensureOwnGuest, ownGuestId, personalLinkOf } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { readBodyText } from "@/lib/http/read-body";
import { describeError } from "@/lib/log-error";

// A guest's id and cookie must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";

// A name is at most 80 characters, so a guest's request is far smaller than this.
const MAX_BODY_BYTES = 4 * 1024;

const guestRequest = zod.object({ displayName: zod.string().nullish() });

function errorResponse(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status, headers: { "Cache-Control": NO_STORE } });
}

// Only JSON. A form on another site can post form data or text/plain here without the browser's
// Lax cookie, which would make a new guest and replace that browser's cookie; JSON from another
// site needs a CORS preflight, which this route never answers.
function isJson(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

/** The body as JSON, an empty one as {}; never reads more than MAX_BODY_BYTES into memory. */
async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const text = await readBodyText(request, MAX_BODY_BYTES);
  if (text === null) return { ok: false, status: 413 };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400 };
  }
}

/**
 * Makes or finds this browser's own guest and returns `{ guestId, link }`, `link` being their
 * personal link (/my/<token>), which the uploader offers under the first upload. Body:
 * `{ displayName? }`. The uploader awaits it once before any upload starts, so a first batch can't
 * race to make several guests. Limited per browser once it has a guest (20, then 1 a second);
 * never by IP.
 */
export async function POST(request: Request) {
  if (!isJson(request)) return errorResponse(415, "unsupported-media-type", "Send the request as JSON.");

  const ownId = await ownGuestId();
  if (ownId) {
    const { allowed, retryAfterSeconds } = takeToken(ownId, "guest");
    if (!allowed) return rateLimitedResponse(retryAfterSeconds);
  }

  const body = await readJson(request);
  if (!body.ok) {
    return body.status === 413
      ? errorResponse(413, "too-large", "The request is too large.")
      : errorResponse(400, "bad-request", "The request isn't valid JSON.");
  }
  const parsed = guestRequest.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, "bad-request", "displayName must be text.");

  try {
    const guest = await ensureOwnGuest(parsed.data.displayName);
    return Response.json({ guestId: guest.id, link: personalLinkOf(guest) }, { headers: { "Cache-Control": NO_STORE } });
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the guest's name.
    console.error("[guest] could not make or find the browser's guest:", describeError(error));
    return errorResponse(503, "unavailable", "Please try again in a moment.");
  }
}
