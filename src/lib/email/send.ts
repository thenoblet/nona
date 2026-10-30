import { Resend } from "resend";

const DEFAULT_FROM = "Noblet & Nancy <rsvp@nobletxnancy.com>";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  ics?: string | null;
  /** Resend returns the first result again for a repeated key, so a retry never double-sends. */
  idempotencyKey?: string;
};

/** `EMAIL_REPLY_TO` takes several addresses separated by commas. */
export function replyToAddresses(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

export async function sendEmail(message: EmailMessage): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    // A missing key must end "failed", never a false "sent".
    if (process.env.NODE_ENV === "production")
      throw new Error("RESEND_API_KEY is not set");
    const domain = message.to.split("@")[1] ?? "unknown";
    console.info(
      `[email] (no RESEND_API_KEY) would send "${message.subject}" to a guest at ${domain}` +
        (message.ics ? " with a calendar file" : ""),
    );
    if (message.ics) console.info(message.ics);
    return;
  }

  const replyTo = replyToAddresses(process.env.EMAIL_REPLY_TO);
  const { error } = await new Resend(key).emails.send(
    {
      from: process.env.EMAIL_FROM || DEFAULT_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(replyTo.length > 0 ? { replyTo } : {}),
      ...(message.ics
        ? {
            attachments: [
              {
                filename: "noblet-and-nancy.ics",
                content: Buffer.from(message.ics),
                contentType: "text/calendar; charset=utf-8",
              },
            ],
          }
        : {}),
    },
    {
      idempotencyKey: message.idempotencyKey,
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (error) throw new Error(`Resend: ${error.message}`);
}
