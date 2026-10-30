import * as zod from "zod";
import { isUuid } from "@/lib/data/ids";
import { jsonResponse, readJsonBody } from "@/lib/http/json";
import { describeError } from "@/lib/log-error";
import { recordUploadEvents, uploadOwners } from "@/lib/media/rows";
import { badRequest, browserGuests, forbidden, unavailable } from "../uploads/access";

// Twenty short events.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 20;

// A reason is a short code ("network-error", "http-403"), never free text that could carry a URL
// with a signature or a guest's name.
const REASON = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The detail the status page uses; anything else the phone sends is dropped. */
const eventDetail = zod.object({
  partNumber: zod.number().int().min(1).max(10_000).optional(),
  attempt: zod.number().int().min(0).max(1_000).optional(),
  httpStatus: zod.number().int().min(0).max(999).optional(),
  online: zod.boolean().optional(),
  elapsedMs: zod.number().int().min(0).max(24 * 60 * 60 * 1000).optional(),
  errorName: zod.string().max(100).optional(),
});

const uploadEvent = zod.object({
  // "resumed" and "completed" are the server's own to record.
  kind: zod.enum(["part-retry", "failed"]),
  mediaId: zod.string().refine(isUuid).optional(),
  reason: zod.string().regex(REASON).optional(),
  detail: eventDetail.optional(),
});

const eventsRequest = zod.object({ events: zod.array(uploadEvent).min(1).max(MAX_EVENTS) });

/**
 * Stores what a phone saw while uploading (a part retried, an upload failed) for the admin's
 * status page. Body: `{ events: [{ kind: "part-retry" | "failed", mediaId?, reason?, detail? }] }`,
 * up to 20 at a time; answers `{ stored }`. Every event's upload must be one of this browser's
 * guests' (403 otherwise). Limited per browser by its own guest (100, then 2 a second).
 */
export async function POST(request: Request) {
  const guests = await browserGuests("events");
  if (!guests.ok) return guests.response;
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = eventsRequest.safeParse(body.value);
  if (!parsed.success) return badRequest("Send up to 20 events of a kind this takes.");
  const { events } = parsed.data;

  try {
    const mediaIds = [...new Set(events.flatMap((event) => (event.mediaId ? [event.mediaId] : [])))];
    if (mediaIds.length > 0) {
      const owners = await uploadOwners(mediaIds);
      const owned = (mediaId: string) => {
        const owner = owners.get(mediaId);
        return owner !== undefined && owner !== null && guests.guestIds.includes(owner);
      };
      if (!mediaIds.every(owned)) return forbidden();
    }
    const [ownId] = guests.guestIds;
    await recordUploadEvents(
      events.map((event) => ({
        guestId: ownId,
        mediaId: event.mediaId ?? null,
        kind: event.kind,
        reason: event.reason ?? null,
        detail: event.detail ?? null,
      })),
    );
    return jsonResponse({ stored: events.length });
  } catch (error) {
    console.error("[uploads] could not store upload events:", describeError(error));
    return unavailable();
  }
}
