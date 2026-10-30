import { readSiteContent } from "@/lib/content/store";
import {
  getRsvp,
  queueWithinDailyLimit,
  setEmailStatus,
} from "@/lib/data/rsvp";
import { describeError } from "@/lib/log-error";
import { renderRsvpConfirmation } from "@/lib/email/rsvp-confirmation";
import { sendEmail } from "@/lib/email/send";
import { emailKey } from "@/lib/rsvp/normalize";
import { siteUrl } from "@/lib/site-url";
import { getBoss, QUEUES } from "./boss";

const DAILY_LIMIT = 3;

/** Queue the confirmation. Never throws: the reply is already saved. */
export async function queueRsvpConfirmation(rsvpId: string): Promise<void> {
  try {
    const rsvp = await getRsvp(rsvpId);
    if (!rsvp?.email) return;
    await queueWithinDailyLimit(
      rsvpId,
      emailKey(rsvp.email),
      DAILY_LIMIT,
      async () => {
        const boss = await getBoss();
        await boss.send(QUEUES.rsvpConfirmation, { rsvpId });
      },
    );
  } catch (error) {
    console.error(
      "Could not queue the RSVP confirmation:",
      describeError(error),
    );
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
