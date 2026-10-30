import { readSiteContent } from "@/lib/content/store";
import {
  confirmationsSentToday,
  getRsvp,
  setEmailStatus,
} from "@/lib/data/rsvp";
import { renderRsvpConfirmation } from "@/lib/email/rsvp-confirmation";
import { sendEmail } from "@/lib/email/send";
import { emailKey } from "@/lib/rsvp/normalize";
import { getBoss, QUEUES } from "./boss";

const DAILY_LIMIT = 3;

export function siteUrl(): string {
  return (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** Queue the confirmation. Never throws: the reply is already saved. */
export async function queueRsvpConfirmation(rsvpId: string): Promise<void> {
  try {
    const r = await getRsvp(rsvpId);
    if (!r?.email) return;
    if ((await confirmationsSentToday(emailKey(r.email))) >= DAILY_LIMIT)
      return;
    const boss = await getBoss();
    await boss.send(QUEUES.rsvpConfirmation, { rsvpId });
    await setEmailStatus(rsvpId, "queued");
  } catch (error) {
    console.error("Could not queue the RSVP confirmation", error);
  }
}

export async function handleRsvpConfirmation(
  rsvpId: string,
  attempt: { retryCount: number; retryLimit: number },
): Promise<void> {
  const r = await getRsvp(rsvpId);
  if (!r || r.supersededAt || !r.email) return;
  try {
    const mail = renderRsvpConfirmation(r, await readSiteContent(), siteUrl());
    await sendEmail({ to: r.email, ...mail });
    await setEmailStatus(r.id, "sent");
  } catch (error) {
    if (attempt.retryCount >= attempt.retryLimit)
      await setEmailStatus(r.id, "failed");
    throw error;
  }
}
