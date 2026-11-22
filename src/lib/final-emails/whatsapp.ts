import { emailCelebrations } from "@/lib/email/celebrations";
import type { SiteContent } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";
import type { FinalKind } from "./audience";
import { finalHelpers, finalStays, finalTravel, weddingDay } from "./content";

/**
 * The final email's message as WhatsApp text, for a guest who gave no email: the couple send it
 * from their own WhatsApp, so it greets the guest by the name they typed. *Stars* are WhatsApp's
 * bold.
 */
export function whatsappMessage(
  kind: FinalKind,
  reply: Pick<RsvpRecord, "fullName" | "answers">,
  content: SiteContent,
  siteUrl: string,
  personalLink: string | null = null,
): string {
  const greeting = `Dear ${reply.fullName.trim()},`;
  if (kind === "thanks") {
    return [
      greeting,
      "Replies are closed, and we have yours. Thank you for letting us know: we'll miss you on the day, and we're grateful you're with us in spirit.",
      `You can still share the day with us. On ${weddingDay(content)}, see it through our guests' eyes in our live album: ${siteUrl}/album\nLeave us a wish: ${siteUrl}/wishes`,
      "With love,\nNoblet & Nancy",
    ].join("\n\n");
  }

  const parts = [
    greeting,
    "Replies are closed, and yours is with us. Thank you for saying yes: it means so much to us. Here is everything you need for the day.",
  ];
  const celebrations = emailCelebrations(reply, content, siteUrl).filter((celebration) => celebration.attending);
  if (celebrations.length > 0) {
    parts.push(
      celebrations
        .map((celebration) => `*${celebration.name}*: ${celebration.date}, ${celebration.time}\n${celebration.place}`)
        .join("\n\n"),
    );
  }
  const helpers = finalHelpers(content);
  if (helpers.length > 0) {
    parts.push(
      [
        "*Need a hand on the day?* Call or WhatsApp one of these friends. We'll be away from our phones.",
        ...helpers.map((helper) => `${helper.name}: ${helper.phone}${helper.note ? ` (${helper.note})` : ""}`),
      ].join("\n"),
    );
  }
  for (const item of finalTravel(content, siteUrl)) {
    parts.push([`*${item.title}*`, ...item.lines, ...(item.link ? [item.link.url] : [])].join("\n"));
  }
  const stays = finalStays(content);
  if (stays.length > 0) {
    parts.push(
      [
        "*Where to stay* (call ahead to book)",
        ...stays.map((stay) => [stay.name, stay.phone, stay.price, stay.note].filter(Boolean).join(", ")),
        `${siteUrl}/stay`,
      ].join("\n"),
    );
  }
  if (personalLink) parts.push(`*Your personal link*, for sharing your photos in the album on the day:\n${personalLink}`);
  parts.push(`Everything is on ${siteUrl}`, "See you in Tepa,\nNoblet & Nancy");
  return parts.join("\n\n");
}
