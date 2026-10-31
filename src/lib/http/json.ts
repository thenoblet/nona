import { readBodyText } from "./read-body";

/** Guest responses name guests and uploads: never in a shared cache such as Cloudflare's. */
export const NO_STORE = "private, no-store";

/** A JSON response that no shared cache keeps. */
export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...headers, "Cache-Control": NO_STORE } });
}

/** An error as `{ error, message }`, or just `{ error }` when it should say nothing more. */
export function errorResponse(status: number, error: string, message?: string): Response {
  return jsonResponse(message === undefined ? { error } : { error, message }, status);
}

/**
 * Whether the request says it is JSON. A form on another site can post form data or text/plain
 * without a CORS preflight; JSON from another site needs one, which these routes never answer.
 */
export function isJsonRequest(request: Request): boolean {
  const mediaType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json";
}

export type JsonBody = { ok: true; value: unknown } | { ok: false; response: Response };

/**
 * The body as JSON (an empty one as {}), never reading more than `maxBytes` into memory. Anything
 * else is the response to send: 415 for a body that isn't JSON, 413 for one too large, 400 for
 * one that doesn't parse.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBody> {
  if (!isJsonRequest(request)) {
    return { ok: false, response: errorResponse(415, "unsupported-media-type", "Send the request as JSON.") };
  }
  const text = await readBodyText(request, maxBytes);
  if (text === null) return { ok: false, response: errorResponse(413, "too-large", "The request is too large.") };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, response: errorResponse(400, "bad-request", "The request isn't valid JSON.") };
  }
}
