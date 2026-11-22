"use server";

import { refresh } from "next/cache";
import { requireAdmin } from "@/lib/admin/access";
import { queueFinalEmails, queueTestEmail, retryFailedFinalEmails, setWhatsappMark } from "@/lib/data/final-emails";
import { listRsvps } from "@/lib/data/rsvp";
import { finalAudience, FINAL_KINDS, newestReply, type FinalKind } from "@/lib/final-emails/audience";
import { queueFinalEmailJobs } from "@/lib/jobs/final-emails";
import { describeError } from "@/lib/log-error";

// Reached by a direct POST as well as from the page, so each action checks the couple first.

export type SendResult = { ok: true; message: string } | { ok: false; error: string };

const NOT_A_KIND = "This page is out of date. Reload it and try again.";
const QUEUE_DOWN = "They're saved and will go out as soon as the email service is back. You can close this page.";

function isKind(kind: unknown): kind is FinalKind {
  return (FINAL_KINDS as readonly unknown[]).includes(kind);
}

/** Hands the emails to the job queue. The rows are saved first, so a queue that's down only delays them. */
async function startSending(ids: string[]): Promise<boolean> {
  try {
    await queueFinalEmailJobs(ids);
    return true;
  } catch (error) {
    console.error("Could not queue the final emails:", describeError(error));
    return false;
  }
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** "Send": the kind's email to every guest with an email who hasn't had it yet. */
export async function sendFinalEmailsAction(kind: FinalKind): Promise<SendResult> {
  const admin = await requireAdmin();
  if (!isKind(kind)) return { ok: false, error: NOT_A_KIND };
  const audience = finalAudience(await listRsvps(), kind);
  const { ids } = await queueFinalEmails(kind, audience.byEmail, admin.email);
  const queued = await startSending(ids);
  refresh();
  if (ids.length === 0) return { ok: true, message: "Everyone has had it already." };
  return { ok: true, message: queued ? `Sending to ${plural(ids.length, "guest")}.` : `${plural(ids.length, "email")} waiting. ${QUEUE_DOWN}` };
}

/** "Try the failed again": the kind's failed emails, sent again. */
export async function retryFailedAction(kind: FinalKind): Promise<SendResult> {
  await requireAdmin();
  if (!isKind(kind)) return { ok: false, error: NOT_A_KIND };
  const ids = await retryFailedFinalEmails(kind);
  const queued = await startSending(ids);
  refresh();
  return { ok: true, message: queued ? `Trying ${plural(ids.length, "email")} again.` : QUEUE_DOWN };
}

/**
 * "Send a test to me": the email as the newest guest of that kind would get it (a sample guest if
 * nobody has replied that way yet), to the signed-in admin's own address.
 */
export async function sendTestAction(kind: FinalKind): Promise<SendResult> {
  const admin = await requireAdmin();
  if (!isKind(kind)) return { ok: false, error: NOT_A_KIND };
  const audience = finalAudience(await listRsvps(), kind);
  const newest = newestReply(audience);
  const id = await queueTestEmail(kind, admin.email, newest?.id ?? null, admin.email);
  const queued = await startSending([id]);
  refresh();
  return { ok: true, message: queued ? `Sending a test to ${admin.email}.` : QUEUE_DOWN };
}

/** The "Sent" tick beside a guest without an email, after the couple sent them the message on WhatsApp. */
export async function markWhatsappAction(kind: FinalKind, phoneKey: string, sent: boolean): Promise<SendResult> {
  const admin = await requireAdmin();
  if (!isKind(kind) || typeof phoneKey !== "string" || !/^\d{6,20}$/.test(phoneKey) || typeof sent !== "boolean") {
    return { ok: false, error: NOT_A_KIND };
  }
  await setWhatsappMark(kind, phoneKey, sent, admin.email);
  refresh();
  return { ok: true, message: sent ? "Ticked." : "Unticked." };
}
