import type { SiteContent } from "@/lib/content/schema";
import { buildIcs, celebrationEvent } from "@/lib/calendar/ics";
import type { RsvpRecord } from "@/lib/data/types";

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function renderRsvpConfirmation(
  r: RsvpRecord,
  content: SiteContent,
  siteUrl: string,
): { subject: string; text: string; html: string; ics: string | null } {
  const replied = content.celebrations.filter((c) => r.answers[c.id]);
  const accepted = replied.filter((c) => r.answers[c.id] === "yes");
  const link = `${siteUrl}/rsvp`;
  const change =
    "Need to change something? Send a new reply with the same name and phone or email.";
  const signOff = "With love, Noblet & Nancy";
  const when = (c: (typeof replied)[number]) =>
    `${c.weekday} ${Number(c.day)} ${c.month}, ${c.time}`;
  const status = (c: (typeof replied)[number]) =>
    r.answers[c.id] === "yes" ? "Attending" : "Not attending";

  const text = [
    `Dear ${r.fullName},`,
    "",
    "Thank you for your reply. Here is what we have for you:",
    "",
    ...replied.map((c) => `${c.name}: ${status(c)}\n${when(c)}\n${c.place}\n`),
    `You can see the details again at ${link}`,
    "",
    change,
    "",
    signOff,
  ].join("\n");

  const html = `<div style="font-family:Georgia,serif;color:#3b2a20;line-height:1.5">
<p>Dear ${escapeHtml(r.fullName)},</p>
<p>Thank you for your reply. Here is what we have for you:</p>
${replied
  .map(
    (c) =>
      `<p><strong>${escapeHtml(c.name)}: ${status(c)}</strong><br>${escapeHtml(when(c))}<br>${escapeHtml(c.place)}</p>`,
  )
  .join("\n")}
<p><a href="${escapeHtml(link)}">See the details again</a></p>
<p>${change}</p>
<p>${signOff}</p>
</div>`;

  const ics =
    accepted.length > 0
      ? buildIcs(accepted.map((c) => celebrationEvent(c, siteUrl)))
      : null;

  return { subject: "Your reply to Noblet & Nancy", text, html, ics };
}
