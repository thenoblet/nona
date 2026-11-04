"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import * as zod from "zod";
import { isUuid } from "@/lib/data/ids";
import { signatureProblem } from "@/lib/data/signature";
import { addWish } from "@/lib/data/wishes";
import { ensureOwnGuest, readGuestIds } from "@/lib/guests/cookie";
import { returnToken, takeToken } from "@/lib/guests/rate-limit";
import { describeError } from "@/lib/log-error";

export type WishFormState = {
  status: "idle" | "error" | "sent";
  errors?: { message?: string; signedAs?: string; form?: string };
  /** What the guest typed, so a failed send keeps their words. */
  values?: { message: string; signedAs: string };
  /** Set after a successful send. */
  sent?: { id: string; signedAs: string };
};

const MAX_MESSAGE = 1000;

const DIDNT_SEND = "Your wish didn't send. Please try again.";
const TOO_MANY = "You've sent a lot of wishes just now. Please wait a few seconds, then send this one.";

/**
 * Saves a written wish in Postgres and re-renders the page so it appears on the wall. It comes from
 * the browser's own guest (made, and the cookie set, when it has none), whose `text-wish` bucket
 * limits it: never by IP (Ruling, global constraints). An honest guest never meets it.
 */
export async function sendWish(_prev: WishFormState, formData: FormData): Promise<WishFormState> {
  const kind = String(formData.get("kind") ?? "text");
  const message = String(formData.get("message") ?? "").trim();
  const signedAs = String(formData.get("signedAs") ?? "").trim();
  const values = { message, signedAs };

  if (kind !== "text") {
    // A recording is sent by the recorder, once it has arrived (sendRecordedWish).
    return { status: "error", values, errors: { form: "Record your wish first, then send it." } };
  }

  const errors: WishFormState["errors"] = {};
  if (!message) errors.message = "Please write a few words for Noblet and Nancy.";
  else if (message.length > MAX_MESSAGE) errors.message = `Please keep your wish under ${MAX_MESSAGE} characters.`;
  const signature = signatureProblem(signedAs);
  if (signature) errors.signedAs = signature;
  if (errors.message || errors.signedAs) return { status: "error", values, errors };

  let wish;
  let turnTakenBy: string | null = null;
  try {
    const guest = await ensureOwnGuest();
    // The turn is taken before the save, so sends side by side can't overrun the bucket, and given
    // back if the save fails: a database blip never uses up a guest's wishes.
    if (!takeToken(guest.id, "text-wish").allowed) return { status: "error", values, errors: { form: TOO_MANY } };
    turnTakenBy = guest.id;
    wish = await addWish({ kind: "text", message, signedAs, guestId: guest.id });
  } catch (error) {
    if (turnTakenBy) returnToken(turnTakenBy, "text-wish");
    console.error("[wishes] could not save a wish:", describeError(error));
    return { status: "error", values, errors: { form: DIDNT_SEND } };
  }

  // The wall is read at request time, so re-rendering the route shows the new wish.
  refresh();
  return { status: "sent", sent: { id: wish.id, signedAs: wish.signedAs } };
}

/** What sending a recorded wish came to. */
export type RecordedWishState =
  | { status: "sent"; sent: { id: string; signedAs: string } }
  /** Past the guest's `wish` limit: the phone waits this long, then sends it again, never showing it as a failure. */
  | { status: "rate-limited"; retryAfterSeconds: number }
  /** The recording isn't one this browser may make a wish of (not its own, the other kind, gone): record it again. */
  | { status: "refused"; message: string }
  | { status: "error"; message: string };

const recordedWishInput = zod.object({
  kind: zod.enum(["voice", "video"]),
  mediaId: zod.string().max(64),
  signedAs: zod.string().max(1024),
});

const REFUSED = "We couldn't find your recording. Please record it again.";

/**
 * Saves a voice or video wish once its recording has arrived (the upload client's complete answered
 * that the server verified it): `addWish({ kind, mediaId, signedAs })`, which links only a finished
 * recording of purpose `wish` that is one of this browser's guests' own, of the wish's kind, once
 * (a send asked again answers the same wish). Then the wall re-renders, where its sender sees
 * "Getting your wish ready…" until media.wish has made it (Ruling BR). Limited by the browser's own
 * guest's `wish` bucket, never by IP; past it the phone waits Retry-After's time and sends again.
 */
export async function sendRecordedWish(input: { kind: "voice" | "video"; mediaId: string; signedAs: string }): Promise<RecordedWishState> {
  const parsed = recordedWishInput.safeParse(input);
  if (!parsed.success) return { status: "error", message: DIDNT_SEND };
  const signedAs = parsed.data.signedAs.trim();
  const signature = signatureProblem(signedAs);
  if (signature) return { status: "error", message: signature };

  try {
    const guestIds = await readGuestIds();
    // A browser with no guest made no recording (the upload made its guest).
    if (guestIds.length === 0 || !isUuid(parsed.data.mediaId)) return { status: "refused", message: REFUSED };
    const { allowed, retryAfterSeconds } = takeToken(guestIds[0], "wish");
    if (!allowed) return { status: "rate-limited", retryAfterSeconds };
    // Linked, its recording is made now (Ruling CE): the job is sent after the response.
    const wish = await addWish({ kind: parsed.data.kind, mediaId: parsed.data.mediaId, signedAs, guestIds }, { defer: after });
    if (!wish) return { status: "refused", message: REFUSED };
    refresh();
    return { status: "sent", sent: { id: wish.id, signedAs: wish.signedAs } };
  } catch (error) {
    console.error("[wishes] could not save a recorded wish:", describeError(error));
    return { status: "error", message: DIDNT_SEND };
  }
}
