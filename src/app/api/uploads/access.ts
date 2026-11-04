import { isUuid } from "@/lib/data/ids";
import { readGuestIds } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken, type RateLimitBucket } from "@/lib/guests/rate-limit";
import { errorResponse } from "@/lib/http/json";
import { findUpload, type UploadRow } from "@/lib/media/rows";
import { UPLOADS_CLOSED_MESSAGE } from "@/lib/media/uploads";

/*
 * What the guest routes share, the upload routes and the album's (album, media, download,
 * playable, remove, wishes/media): who the browser is, whether it may touch an upload, and the
 * answers they give. Not a route itself (only route.ts files are).
 */

/** Not this browser's to touch, or no such upload: the same answer, with nothing more said. */
export const forbidden = () => errorResponse(403, "forbidden");
export const uploadsClosed = () => errorResponse(403, "uploads-closed", UPLOADS_CLOSED_MESSAGE);
export const badRequest = (message: string) => errorResponse(400, "bad-request", message);
export const unavailable = () => errorResponse(503, "unavailable", "Please try again in a moment.");
export const alreadyUploaded = () => errorResponse(409, "already-uploaded", "This file has already been sent.");
export const uploadMissing = () =>
  errorResponse(409, "upload-missing", "This upload has expired. Please choose the file again.");

export type BrowserGuests = { ok: true; guestIds: string[] } | { ok: false; response: Response };

/**
 * Every guest this browser knows (its own first), after taking one request from its own guest's
 * bucket. A browser without a guest has no uploads, so it is refused; one over its limit gets the
 * 429 with Retry-After.
 */
export async function browserGuests(bucket: RateLimitBucket): Promise<BrowserGuests> {
  const guestIds = await readGuestIds();
  if (guestIds.length === 0) return { ok: false, response: forbidden() };
  const { allowed, retryAfterSeconds } = takeToken(guestIds[0], bucket);
  if (!allowed) return { ok: false, response: rateLimitedResponse(retryAfterSeconds) };
  return { ok: true, guestIds };
}

export type ViewerGuests = { ok: true; guestIds: string[] } | { ok: false; response: Response };

/**
 * Every guest this browser knows (its own first), for what anyone may look at (the album, a
 * moment, a download): a browser without a guest is let through with none; one with a guest takes a
 * request from its own guest's bucket, and past its limit gets the 429 with Retry-After. Never by IP.
 */
export async function viewerGuests(bucket: RateLimitBucket): Promise<ViewerGuests> {
  const guestIds = await readGuestIds();
  if (guestIds.length === 0) return { ok: true, guestIds };
  const { allowed, retryAfterSeconds } = takeToken(guestIds[0], bucket);
  if (!allowed) return { ok: false, response: rateLimitedResponse(retryAfterSeconds) };
  return { ok: true, guestIds };
}

/** The upload, when one of the browser's guests uploaded it; null otherwise (one primary-key read). */
export async function ownedUpload(mediaId: string, guestIds: string[]): Promise<UploadRow | null> {
  if (!isUuid(mediaId)) return null;
  const upload = await findUpload(mediaId);
  if (!upload?.guestId || !guestIds.includes(upload.guestId)) return null;
  return upload;
}

/** The [id] segment's context, as Next passes it to a route handler. */
export type UploadContext = { params: Promise<{ id: string }> };
