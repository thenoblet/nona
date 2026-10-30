import type { SiteContent } from "@/lib/content/schema";
import { buildIcs, celebrationEvent } from "@/lib/calendar/ics";
import type { RsvpRecord } from "@/lib/data/types";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Only a plain name is echoed back: the address is unverified, so a link must not ride along. */
function greetingName(fullName: string): string {
  // A period only ends an initial or suffix ("J. Doe", "Jr."), so "bit.ly" is not a name.
  const plain =
    fullName.length <= 60 && /^(?:[\p{L}\p{M}' -]|\.(?= |$))+$/u.test(fullName);
  return plain ? fullName : "guest";
}

export function renderRsvpConfirmation(
  rsvp: RsvpRecord,
  content: SiteContent,
  siteUrl: string,
): { subject: string; text: string; html: string; ics: string | null } {
  const greeting = `Dear ${greetingName(rsvp.fullName)}`;
  const replied = content.celebrations.filter(
    (celebration) => rsvp.answers[celebration.id],
  );
  const accepted = replied.filter(
    (celebration) => rsvp.answers[celebration.id] === "yes",
  );
  const link = `${siteUrl}/rsvp`;
  const change =
    "Need to change something? Send a new reply with the same name and phone or email.";
  const signOff = "With love, Noblet & Nancy";
  const when = (celebration: (typeof replied)[number]) =>
    `${celebration.weekday} ${Number(celebration.day)} ${celebration.month}, ${celebration.time}`;
  const status = (celebration: (typeof replied)[number]) =>
    rsvp.answers[celebration.id] === "yes" ? "Attending" : "Not attending";

  const text = [
    `${greeting},`,
    "",
    "Thank you for your reply. Here is what we have for you:",
    "",
    ...replied.map(
      (celebration) =>
        `${celebration.name}: ${status(celebration)}\n${when(celebration)}\n${celebration.place}\n`,
    ),
    `You can see the details again at ${link}`,
    "",
    change,
    "",
    signOff,
  ].join("\n");

  const html = `<div style="font-family:Georgia,serif;color:#3b2a20;line-height:1.5">
<p>${escapeHtml(greeting)},</p>
<p>Thank you for your reply. Here is what we have for you:</p>
${replied
  .map(
    (celebration) =>
      `<p><strong>${escapeHtml(celebration.name)}: ${status(celebration)}</strong><br>${escapeHtml(when(celebration))}<br>${escapeHtml(celebration.place)}</p>`,
  )
  .join("\n")}
<p><a href="${escapeHtml(link)}">See the details again</a></p>
<p>${change}</p>
<p>${signOff}</p>
</div>`;

  const ics =
    accepted.length > 0
      ? buildIcs(
          accepted.map((celebration) => celebrationEvent(celebration, siteUrl)),
          new Date(rsvp.receivedAt),
        )
      : null;

  return { subject: "Your reply to Noblet & Nancy", text, html, ics };
}
