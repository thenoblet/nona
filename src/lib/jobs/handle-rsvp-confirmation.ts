import { readSiteContent } from "@/lib/content/store";
import { getRsvp, setEmailStatus } from "@/lib/data/rsvp";
import { renderRsvpConfirmation } from "@/lib/email/rsvp-confirmation";
import { sendEmail } from "@/lib/email/send";
import { siteUrl } from "@/lib/site-url";

/**
 * The confirmation job: render the reply's email and send it. Only the job queue's worker
 * (start-jobs.ts) imports this, so the renderer (React Email) stays out of the pages' bundles.
 */
export async function handleRsvpConfirmation(
  rsvpId: string,
  attempt: { retryCount: number; retryLimit: number },
): Promise<void> {
  const rsvp = await getRsvp(rsvpId);
  if (!rsvp || rsvp.supersededAt || !rsvp.email) return;
  try {
    const mail = await renderRsvpConfirmation(
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
