import { after } from "next/server";
import * as zod from "zod";
import { cleanFilename, cleanName } from "@/lib/data/text";
import { ensureOwnGuest, ownGuestId } from "@/lib/guests/cookie";
import { rateLimitedResponse, takeToken } from "@/lib/guests/rate-limit";
import { errorResponse, jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { checkUpload } from "@/lib/media/limits";
import { findResumableUpload, isHiddenByCouple, isUnknownGuest } from "@/lib/media/rows";
import {
  createUpload,
  mayContinueUpload,
  mayStartUpload,
  readUploadsSwitch,
  resumeUpload,
  UPLOADS_ALWAYS_OPEN,
} from "@/lib/media/uploads";
import { badRequest, unavailable, uploadsClosed } from "./access";

// A filename and a name: a real request is well under 2 KB.
const MAX_BODY_BYTES = 8 * 1024;

// The phone's sha-256 of the file's size, first MB and last MB, as hex or base64.
const FINGERPRINT = /^[A-Za-z0-9+/=_-]{16,128}$/;

const startRequest = zod.object({
  purpose: zod.enum(["album", "wish"]),
  filename: zod.string().max(1024),
  size: zod.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  contentType: zod.string().max(255),
  fingerprint: zod.string().regex(FINGERPRINT),
  capturedAt: zod.iso.datetime({ offset: true }).nullish(),
  uploaderName: zod.string().max(1024).nullish(),
});

/**
 * Starts an upload, or resumes this browser's unfinished upload of the same file.
 *
 * Body: `{ purpose: "album" | "wish", filename, size, contentType, fingerprint, capturedAt?, uploaderName? }`.
 * Answers `{ mediaId, uploadId, key, partSize, partCount, uploadedParts }`: parts of 8 MiB, or 16
 * MiB for a file of 256 MiB or more, kept by an upload carried on. The phone then asks
 * /api/uploads/[id]/parts for part URLs and sends the bytes straight to R2. The upload's manifest
 * is written after the answer (Ruling AY).
 * - A file of the wrong type, empty or over its limit: 400 `{ error, message }` in plain words.
 * - Album uploads while the couple have them closed: 403 `uploads-closed`, unless it resumes an
 *   upload started before the close, within 24 hours of it. Wishes are never closed.
 * - The same file again (same guest, purpose, size and fingerprint, still uploading), even renamed:
 *   its existing upload, with the parts already sent.
 * - A browser without a guest (no cookie, or one the server didn't sign): 403 `no-guest`. The phone
 *   awaits POST /api/guest before its first start, so starts never race to make guests.
 * - The same file (size and fingerprint) as an item the couple hid, from any guest's phone: 409
 *   `hidden`, and nothing is made (Ruling AX). A guest's own removal doesn't block them.
 * Limited per browser by its own guest (a burst of 100, then 2 a second); never by IP.
 */
export async function POST(request: Request) {
  const ownId = await ownGuestId();
  if (!ownId) return errorResponse(403, "no-guest");
  const { allowed, retryAfterSeconds } = takeToken(ownId, "start");
  if (!allowed) return rateLimitedResponse(retryAfterSeconds);

  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = startRequest.safeParse(body.value);
  if (!parsed.success) return badRequest("The upload's details aren't valid.");
  const { purpose, filename, size, contentType, fingerprint } = parsed.data;
  const checked = checkUpload({ purpose, filename, contentType, size });
  if (!checked.ok) return errorResponse(400, checked.error, checked.message);

  const options = { signal: request.signal, defer: after };
  try {
    // The reads at once: a burst of starts shares the database pool.
    const [uploads, unfinished, hidden] = await Promise.all([
      purpose === "album" ? readUploadsSwitch() : UPLOADS_ALWAYS_OPEN,
      findResumableUpload({ guestId: ownId, purpose, sizeBytes: size, fingerprint }),
      isHiddenByCouple({ sizeBytes: size, fingerprint }),
    ]);
    if (hidden) return errorResponse(409, "hidden");
    if (unfinished) {
      if (!mayContinueUpload(unfinished, uploads)) return uploadsClosed();
      const resumed = await resumeUpload(unfinished, options);
      if (resumed) return jsonResponse(resumed);
    }
    if (!mayStartUpload(purpose, uploads)) return uploadsClosed();

    // With no name of its own, the upload takes its guest's.
    const uploaderName = cleanName(parsed.data.uploaderName);
    const capturedAt = parsed.data.capturedAt ? new Date(parsed.data.capturedAt) : null;
    const create = (guestId: string) =>
      createUpload(
        {
          purpose,
          kind: checked.kind,
          guestId,
          uploaderName,
          originalFilename: cleanFilename(filename),
          sizeBytes: size,
          contentType: checked.contentType,
          extension: checked.extension,
          fingerprint,
          capturedAt,
        },
        options,
      );
    // The cookie's guest is taken at its word, without a lookup: the row's foreign key refuses a
    // guest the database no longer has (a cookie older than a restore), and the browser then gets
    // a new own guest, named from the upload.
    try {
      return jsonResponse(await create(ownId));
    } catch (error) {
      if (!isUnknownGuest(error)) throw error;
      return jsonResponse(await create((await ensureOwnGuest(uploaderName)).id));
    }
  } catch (error) {
    // The error's name and code only: a query error carries its parameters (names, filenames).
    console.error("[uploads] could not start an upload:", describeError(error));
    return unavailable();
  }
}
