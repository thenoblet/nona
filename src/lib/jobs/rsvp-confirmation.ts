import { readSiteContent } from "@/lib/content/store";
import {
  getRsvp,
  queueWithinDailyLimit,
  setEmailStatus,
  unsentConfirmationIds,
} from "@/lib/data/rsvp";
import { describeError } from "@/lib/log-error";
import { renderRsvpConfirmation } from "@/lib/email/rsvp-confirmation";
import { sendEmail } from "@/lib/email/send";
import { emailKey } from "@/lib/rsvp/normalize";
import { siteUrl } from "@/lib/site-url";
import { getBoss, QUEUES } from "./boss";

const DAILY_LIMIT = 3;

/**
 * Queue the confirmation; true when a job was queued. Never throws: the reply is already saved,
 * and one left unqueued shows as "Not sent" until the queue's next start tries it again.
 */
export async function queueRsvpConfirmation(rsvpId: string): Promise<boolean> {
  try {
    const rsvp = await getRsvp(rsvpId);
    if (!rsvp?.email) return false;
    // Started before the transaction, so a queue that is slow to start never holds the email's
    // lock or a pooled connection while it does.
    const boss = await getBoss();
    return await queueWithinDailyLimit(
      rsvpId,
      emailKey(rsvp.email),
      DAILY_LIMIT,
      async () => {
        await boss.send(QUEUES.rsvpConfirmation, { rsvpId });
      },
    );
  } catch (error) {
    console.error(
      "Could not queue the RSVP confirmation:",
      describeError(error),
    );
    return false;
  }
}

/**
 * When the job queue starts: queue the confirmations of the last day's replies that have an email
 * but nothing queued, each through the daily cap. Never throws.
 */
export async function requeueUnsentConfirmations(): Promise<void> {
  try {
    const ids = await unsentConfirmationIds();
    let queued = 0;
    for (const id of ids) {
      if (await queueRsvpConfirmation(id)) queued += 1;
    }
    if (ids.length > 0) console.info(`Queued ${queued} of ${ids.length} RSVP confirmations not sent before`);
  } catch (error) {
    console.error("Could not queue the unsent RSVP confirmations:", describeError(error));
  }
}

export async function handleRsvpConfirmation(
  rsvpId: string,
  attempt: { retryCount: number; retryLimit: number },
): Promise<void> {
  const rsvp = await getRsvp(rsvpId);
  if (!rsvp || rsvp.supersededAt || !rsvp.email) return;
  try {
    const mail = renderRsvpConfirmation(
      rsvp,
      await readSiteContent(),
      siteUrl(),
    );
    await sendEmail({
      to: rsvp.email,
      idempotencyKey: `rsvp-confirmation/${rsvp.id}`,
      ...mail,
    });
    await setEmailStatus(rsvp.id, "sent");
  } catch (error) {
    if (attempt.retryCount >= attempt.retryLimit)
      await setEmailStatus(rsvp.id, "failed");
    throw error;
  }
}
