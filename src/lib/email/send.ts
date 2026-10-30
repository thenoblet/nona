import { Resend } from "resend";

const DEFAULT_FROM = "Noblet & Nancy <rsvp@nobletxnancy.com>";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  ics?: string | null;
};

/** `EMAIL_REPLY_TO` takes several addresses separated by commas. */
export function replyToAddresses(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // A missing key must end "failed", never a false "sent".
    if (process.env.NODE_ENV === "production")
      throw new Error("RESEND_API_KEY is not set");
    const domain = msg.to.split("@")[1] ?? "unknown";
    console.info(
      `[email] (no RESEND_API_KEY) would send "${msg.subject}" to a guest at ${domain}` +
        (msg.ics ? " with a calendar file" : ""),
    );
    if (msg.ics) console.info(msg.ics);
    return;
  }

  const replyTo = replyToAddresses(process.env.EMAIL_REPLY_TO);
  const { error } = await new Resend(key).emails.send({
    from: process.env.EMAIL_FROM || DEFAULT_FROM,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    ...(replyTo.length > 0 ? { replyTo } : {}),
    ...(msg.ics
      ? {
          attachments: [
            {
              filename: "noblet-and-nancy.ics",
              content: Buffer.from(msg.ics),
              contentType: "text/calendar; charset=utf-8",
            },
          ],
        }
      : {}),
  });
  if (error) throw new Error(`Resend: ${error.message}`);
}
