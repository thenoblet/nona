"use server";

import { after } from "next/server";
import * as zod from "zod";
import { contentDefaults } from "@/lib/content/defaults";
import { getSiteContentOrThrow } from "@/lib/content/get";
import type { SiteContent } from "@/lib/content/schema";
import { saveRsvp } from "@/lib/data/rsvp";
import { guestForReply } from "@/lib/guests/cookie";
import { queueRsvpConfirmation } from "@/lib/jobs/rsvp-confirmation";
import { describeError } from "@/lib/log-error";
import type { Answer } from "@/lib/data/types";
import {
  answerField,
  partySizes,
  type RsvpErrors,
  type RsvpState,
  type RsvpValues,
} from "@/components/rsvp/options";

const TRY_AGAIN = "Sorry, your reply didn't reach us. Please try again in a moment.";

/** Trimmed text from the form, capped so nobody can post a novel. */
function text(form: FormData, key: string, max = 300) {
  const value = form.get(key);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function oneOf<TValue extends string>(value: string, allowed: readonly TValue[]): TValue {
  return (allowed as readonly string[]).includes(value)
    ? (value as TValue)
    : allowed[0];
}

export async function submitRsvp(
  _prev: RsvpState,
  form: FormData,
): Promise<RsvpState> {
  // Whether replies are open comes from the database itself, never from the built-in text pages
  // fall back to during an outage (in which replies are open). If it can't be read, the guest is
  // asked to try again, and is not told that replies have closed.
  let content: SiteContent | null = null;
  try {
    content = await getSiteContentOrThrow();
  } catch (error) {
    console.error("RSVP could not check whether replies are open:", describeError(error));
  }
  // The celebrations' ids are fixed, so the built-in ones read the answers back into the form.
  const answers: RsvpValues["answers"] = {};
  for (const celebration of (content ?? contentDefaults).celebrations) {
    const answer = form.get(answerField(celebration.id));
    if (answer === "yes" || answer === "no") answers[celebration.id] = answer as Answer;
  }

  const values: RsvpValues = {
    fullName: text(form, "fullName", 120),
    phone: text(form, "phone", 40),
    email: text(form, "email", 200),
    partySize: oneOf(text(form, "partySize"), partySizes),
    answers,
    otherNames: text(form, "otherNames"),
    song: text(form, "song", 120),
  };

  if (!content) {
    return { status: "error", values, errors: { form: TRY_AGAIN } };
  }
  // A phone may have had the form open since before the couple closed replies: the form keeps
  // what was typed, and shows the closed message instead of saving.
  if (!content.rsvp.open) {
    return { status: "error", values, errors: { form: content.rsvp.closedMessage } };
  }

  const errors: RsvpErrors = {};
  if (values.fullName.length < 2) {
    errors.fullName = "Please tell us your full name, so we know who's coming.";
  }
  if (!values.phone) {
    errors.phone =
      "Please add a phone or WhatsApp number, so we can send you updates.";
  } else if (values.phone.replace(/\D/g, "").length < 7) {
    errors.phone = "That number looks a little short. Could you check it?";
  }
  if (values.email && !zod.email().safeParse(values.email).success) {
    errors.email = "That email doesn't look right. Could you check it?";
  }
  if (Object.keys(answers).length === 0) {
    errors.answers = "Please let us know about at least one celebration.";
  }
  if (Object.keys(errors).length > 0) {
    return { status: "error", values, errors };
  }

  // The guest the reply is sent as, made or found for this browser (Ruling BY): their personal
  // link goes in the confirmation, and the album knows the phone as them. The reply never waits
  // on it: without a guest it is saved as before, and its email has no link.
  let guestId: string | undefined;
  try {
    guestId = (await guestForReply(values.fullName)).id;
  } catch (error) {
    // The error's name and code only: a query error repeats the guest's name.
    console.error("RSVP could not find or make the guest:", describeError(error));
  }

  let record: Awaited<ReturnType<typeof saveRsvp>>["record"];
  try {
    ({ record } = await saveRsvp({
      fullName: values.fullName,
      phone: values.phone,
      email: values.email || undefined,
      partySize: values.partySize,
      answers: values.answers,
      otherNames: values.otherNames || undefined,
      song: values.song || undefined,
      guestId,
    }));
  } catch (error) {
    // Never the error itself: a query error repeats the guest's name, phone and email.
    console.error("RSVP could not be saved:", describeError(error));
    return {
      status: "error",
      values,
      errors: { form: TRY_AGAIN },
    };
  }

  if (record.email) {
    after(() => queueRsvpConfirmation(record.id));
  }

  return { status: "sent", values, errors: {} };
}
