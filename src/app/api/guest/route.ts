import * as zod from "zod";
import { ensureOwnGuest, ownGuestId, personalLinkOf, renameOwnGuest } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { readBodyText } from "@/lib/http/read-body";
import { describeError } from "@/lib/log-error";

// A guest's id and cookie must never sit in a shared cache such as Cloudflare's.
const NO_STORE = "private, no-store";

// A name is at most 80 characters, so a guest's request is far smaller than this.
const MAX_BODY_BYTES = 4 * 1024;

const guestRequest = zod.object({ displayName: zod.string().nullish() });
const renameRequest = zod.object({ displayName: zod.string() });

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
 * The JSON body of a request from a browser not over its limit, or the answer refusing it: 415 for
 * anything but JSON, 429 once the browser's own guest is over its limit (20, then 1 a second;
 * never by IP), 413 over 4 KB, 400 for JSON that isn't.
 */
async function guestBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  if (!isJson(request)) return { ok: false, response: errorResponse(415, "unsupported-media-type", "Send the request as JSON.") };

  const ownId = await ownGuestId();
  if (ownId) {
    const { allowed, retryAfterSeconds } = takeToken(ownId, "guest");
    if (!allowed) return { ok: false, response: rateLimitedResponse(retryAfterSeconds) };
  }

  const body = await readJson(request);
  if (!body.ok) {
    return {
      ok: false,
      response:
        body.status === 413
          ? errorResponse(413, "too-large", "The request is too large.")
          : errorResponse(400, "bad-request", "The request isn't valid JSON."),
    };
  }
  return body;
}

/**
 * Makes or finds this browser's own guest and returns `{ guestId, link, displayName }`, `link`
 * being their personal link (/my/<token>), which the uploader offers under the first upload. Body:
 * `{ displayName? }`, which names a new guest, or one who has none, but never renames one (Ruling
 * CG: PATCH does, when the guest taps Change). The uploader awaits it once before any upload starts,
 * so a first batch can't race to make several guests; an album page that comes back into view asks
 * again, to learn whether a personal link took the phone over meanwhile.
 */
export async function POST(request: Request) {
  const body = await guestBody(request);
  if (!body.ok) return body.response;
  const parsed = guestRequest.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, "bad-request", "displayName must be text.");

  try {
    const guest = await ensureOwnGuest(parsed.data.displayName);
    return Response.json(
      { guestId: guest.id, link: personalLinkOf(guest), displayName: guest.displayName },
      { headers: { "Cache-Control": NO_STORE } },
    );
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the guest's name.
    console.error("[guest] could not make or find the browser's guest:", describeError(error));
    return errorResponse(503, "unavailable", "Please try again in a moment.");
  }
}

/**
 * Renames this browser's own guest, as the guest asks by tapping Change beside "Sharing as" (Ruling
 * CG). Body: `{ displayName }`; a blank one leaves the name. Answers `{ guestId, displayName }`, or
 * 204 when the browser has no guest yet (the name then goes with its first upload), making none.
 * JSON only and limited as POST is.
 */
export async function PATCH(request: Request) {
  const body = await guestBody(request);
  if (!body.ok) return body.response;
  const parsed = renameRequest.safeParse(body.value);
  if (!parsed.success) return errorResponse(400, "bad-request", "displayName must be text.");

  try {
    const guest = await renameOwnGuest(parsed.data.displayName);
    if (!guest) return new Response(null, { status: 204, headers: { "Cache-Control": NO_STORE } });
    return Response.json({ guestId: guest.id, displayName: guest.displayName }, { headers: { "Cache-Control": NO_STORE } });
  } catch (error) {
    // The error's name and code only: a query error carries its parameters, here the guest's name.
    console.error("[guest] could not rename the browser's guest:", describeError(error));
    return errorResponse(503, "unavailable", "Please try again in a moment.");
  }
}
