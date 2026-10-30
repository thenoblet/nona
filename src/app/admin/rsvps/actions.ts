"use server";

import { refresh } from "next/cache";
import * as zod from "zod";
import { requireAdmin } from "@/lib/admin/access";
import { keepBoth, keepReply, REPLY_NOT_FOUND, type KeepResult } from "@/lib/data/rsvp";

// Reached by a direct POST as well as from the page, so each action checks the couple first.
const replyId = zod.uuid();
const listedReplyIds = zod.array(zod.uuid()).max(50);

/**
 * "Keep this one": the replies the page showed flagged against this one (`expectedOtherIds`) move
 * into its history. If a reply arrived since, nothing moves and the re-rendered page shows it.
 */
export async function keepReplyAction(id: string, expectedOtherIds: string[]): Promise<KeepResult> {
  await requireAdmin();
  const listed = listedReplyIds.safeParse(expectedOtherIds);
  if (!replyId.safeParse(id).success || !listed.success) return { ok: false, error: REPLY_NOT_FOUND };
  const result = await keepReply(
    id.toLowerCase(),
    listed.data.map((otherId) => otherId.toLowerCase()),
  );
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
