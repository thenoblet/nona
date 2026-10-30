"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin/access";
import { keepBoth, keepReply, REPLY_NOT_FOUND, type KeepResult } from "@/lib/data/rsvp";

// Reached by a direct POST as well as from the page, so each action checks the couple first.
const replyId = z.uuid();

/** "Keep this one": every reply flagged against this one moves into its history. */
export async function keepReplyAction(id: string): Promise<KeepResult> {
  await requireAdmin();
  if (!replyId.safeParse(id).success) return { ok: false, error: REPLY_NOT_FOUND };
  const result = await keepReply(id.toLowerCase());
  // The replies are read at request time, so re-rendering the page shows the change.
  refresh();
  return result;
}

/** "Keep both": the two replies stay current and are no longer flagged against each other. */
export async function keepBothAction(
  id: string,
  otherId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const admin = await requireAdmin();
  if (!replyId.safeParse(id).success || !replyId.safeParse(otherId).success) {
    return { ok: false, error: REPLY_NOT_FOUND };
  }
  const result = await keepBoth(id.toLowerCase(), otherId.toLowerCase(), admin.email);
  refresh();
  return result;
}
