"use server";

import { refresh } from "next/cache";
import { addWish } from "@/lib/data/wishes";
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
const MAX_NAME = 80;

/** Saves a written wish and re-renders the page so it appears on the wall. */
export async function sendWish(_prev: WishFormState, formData: FormData): Promise<WishFormState> {
  const kind = String(formData.get("kind") ?? "text");
  const message = String(formData.get("message") ?? "").trim();
  const signedAs = String(formData.get("signedAs") ?? "").trim();
  const values = { message, signedAs };

  if (kind !== "text") {
    // TODO: voice and video wishes arrive as files uploaded to S3 first.
    return { status: "error", values, errors: { form: "Voice and video wishes are on their way. For now, please write yours." } };
  }

  const errors: WishFormState["errors"] = {};
  if (!message) errors.message = "Please write a few words for Noblet and Nancy.";
  else if (message.length > MAX_MESSAGE) errors.message = `Please keep your wish under ${MAX_MESSAGE} characters.`;
  if (!signedAs) errors.signedAs = "Please sign your wish with your name.";
  else if (signedAs.length > MAX_NAME) errors.signedAs = `Please keep your name under ${MAX_NAME} characters.`;
  if (errors.message || errors.signedAs) return { status: "error", values, errors };

  let wish;
  try {
    wish = await addWish({ kind: "text", message, signedAs });
  } catch (error) {
    console.error("[wishes] could not save a wish:", describeError(error));
    return { status: "error", values, errors: { form: "Your wish didn't send. Please try again." } };
  }

  // The wall is read at request time, so re-rendering the route shows the new wish.
  refresh();
  return { status: "sent", sent: { id: wish.id, signedAs: wish.signedAs } };
}
