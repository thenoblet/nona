import { readSiteContent } from "@/lib/content/store";
import { getFinalEmail, markFinalEmailFailed, markFinalEmailSent } from "@/lib/data/final-emails";
import { getRsvp } from "@/lib/data/rsvp";
import { renderFinalEmail } from "@/lib/email/final-emails";
import { sendEmail } from "@/lib/email/send";
import { personalLink } from "@/lib/guests/personal-link";
import { errorMessage } from "@/lib/log-error";
import { siteUrl } from "@/lib/site-url";

/** Who a test is written for when no guest has replied that way yet. */
const SAMPLE_REPLY = { fullName: "Ama Owusu", answers: { ceremony: "yes", reception: "yes" } } as const;

/**
 * The final-email job: render one queued final email from the site text as it is now and send it.
 * The idempotency key is the kind and the address, so a retry, or the same email queued twice,
 * never reaches a guest twice. A test goes to the couple, written from a guest's reply but without
 * that guest's personal link. Only the job queue's worker (start-jobs.ts) imports this.
 */
export async function handleFinalEmail(id: string, attempt: { retryCount: number; retryLimit: number }): Promise<void> {
  const email = await getFinalEmail(id);
  if (!email || email.status === "sent") return;
  try {
    const reply = email.rsvpId ? await getRsvp(email.rsvpId) : null;
    // A guest's reply removed since it was queued: nothing to write from (a test uses the sample).
    if (!reply && !email.test) {
      await markFinalEmailFailed(id, "The reply was deleted before the email went out.");
      return;
    }
    const link = !email.test && reply?.guestId ? await personalLink(reply.guestId) : null;
    const mail = await renderFinalEmail(email.kind, reply ?? SAMPLE_REPLY, await readSiteContent(), siteUrl(), link);
    await sendEmail({
      to: email.email,
      idempotencyKey: email.test ? `final-test/${email.id}` : `final/${email.kind}/${email.emailKey}`,
      ...mail,
      subject: email.test ? `[Test] ${mail.subject}` : mail.subject,
    });
    await markFinalEmailSent(id);
  } catch (error) {
    if (attempt.retryCount >= attempt.retryLimit) await markFinalEmailFailed(id, errorMessage(error));
    throw error;
  }
}
