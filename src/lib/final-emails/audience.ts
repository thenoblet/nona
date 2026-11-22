import { GUEST_EVENT_IDS } from "@/lib/content/schema";
import type { RsvpRecord } from "@/lib/data/types";
import { emailKey, phoneKey } from "@/lib/rsvp/normalize";

/** "details" for guests coming, "thanks" for guests who said they can't. */
export type FinalKind = "details" | "thanks";
export const FINAL_KINDS = ["details", "thanks"] as const satisfies readonly FinalKind[];

/** Coming to any celebration, not coming to any, or not answered at all (left out). */
export function finalKindOf(reply: Pick<RsvpRecord, "answers">): FinalKind | null {
  const answers = GUEST_EVENT_IDS.map((id) => reply.answers[id]).filter(Boolean);
  if (answers.length === 0) return null;
  return answers.includes("yes") ? "details" : "thanks";
}

export type EmailRecipient = { reply: RsvpRecord; email: string; emailKey: string };
export type WhatsappRecipient = { reply: RsvpRecord; phoneKey: string };

export type Audience = {
  /** One per email address, the newest reply's, so a shared address gets one email. */
  byEmail: EmailRecipient[];
  /** Replies that share an address with a newer one and get no email of their own. */
  merged: number;
  /** Replies with no email: the couple send these the message on WhatsApp. */
  byWhatsapp: WhatsappRecipient[];
};

/**
 * Who gets a kind of final email: the current replies (not moved into another's history) of that
 * kind, those with an email by address and the rest by phone. Newest reply first, as the couple
 * see them in Replies.
 */
export function finalAudience(replies: readonly RsvpRecord[], kind: FinalKind): Audience {
  const current = replies
    .filter((reply) => !reply.supersededAt && finalKindOf(reply) === kind)
    .toSorted((first, second) => second.receivedAt.localeCompare(first.receivedAt));
  const byEmail: EmailRecipient[] = [];
  const seen = new Set<string>();
  let merged = 0;
  const byWhatsapp: WhatsappRecipient[] = [];
  for (const reply of current) {
    const email = reply.email?.trim();
    if (!email) {
      byWhatsapp.push({ reply, phoneKey: phoneKey(reply.phone) });
      continue;
    }
    const key = emailKey(email);
    if (seen.has(key)) {
      merged += 1;
      continue;
    }
    seen.add(key);
    byEmail.push({ reply, email, emailKey: key });
  }
  return { byEmail, merged, byWhatsapp };
}
