"use server";

import { refresh, updateTag } from "next/cache";
import * as zod from "zod";
import { requireAdmin } from "@/lib/admin/access";
import { isVersionNumber, newerVersionMessage, RELOAD, type SaveState } from "@/lib/admin/content";
import { CONTENT_TAG } from "@/lib/content/get";
import { readSection, saveSection, type SaveResult } from "@/lib/content/store";
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

// The RSVP settings. Each change carries the version the page showed: if anyone saved after it,
// nothing changes and the couple are told who did and when, as on the Site text pages.

/** After a save, guests' pages and the reply action read the new settings at once, and this page re-renders. */
function settingsSaved(result: SaveResult, adminEmail: string): SaveState {
  if (!result.ok) {
    return { status: "error", errors: result.newer ? [newerVersionMessage(result.newer, adminEmail)] : result.errors };
  }
  updateTag(CONTENT_TAG);
  refresh();
  return { status: "saved", errors: [], version: result.version };
}

/** Closes or reopens replies; the date and message stay as saved. */
async function saveRepliesOpen(admin: { email: string }, open: boolean, baseVersion: number): Promise<SaveState> {
  if (!isVersionNumber(baseVersion)) return { status: "error", errors: [RELOAD] };
  const { value } = await readSection("rsvp");
  const result = await saveSection("rsvp", { ...value, open }, admin.email, { baseVersion });
  return settingsSaved(result, admin.email);
}

/** "Close RSVPs": /rsvp shows the closed message, and a reply sent from a page loaded earlier is refused. */
export async function closeRsvpsAction(baseVersion: number): Promise<SaveState> {
  const admin = await requireAdmin();
  return saveRepliesOpen(admin, false, baseVersion);
}

/** "Reopen RSVPs": the form is back. */
export async function reopenRsvpsAction(baseVersion: number): Promise<SaveState> {
  const admin = await requireAdmin();
  return saveRepliesOpen(admin, true, baseVersion);
}

/** Saves the reply-by date and the closed message together; replies stay open or closed as they were. */
export async function saveRsvpSettingsAction(form: FormData): Promise<SaveState> {
  const admin = await requireAdmin();
  const replyBy = form.get("replyBy");
  const closedMessage = form.get("closedMessage");
  const baseVersion = form.get("baseVersion");
  if (typeof replyBy !== "string" || typeof closedMessage !== "string" || typeof baseVersion !== "string" || !/^\d{1,9}$/.test(baseVersion)) {
    return { status: "error", errors: [RELOAD] };
  }
  const { value } = await readSection("rsvp");
  const result = await saveSection("rsvp", { ...value, replyBy, closedMessage }, admin.email, { baseVersion: Number(baseVersion) });
  return settingsSaved(result, admin.email);
}
