"use server";

import { refresh } from "next/cache";
import * as zod from "zod";
import { coupleEmails, requireAdmin } from "@/lib/admin/access";
import { addViewer, emailForAccess, removeViewer } from "@/lib/data/admin-viewers";

export type PeopleResult = { ok: true; message: string } | { ok: false; error: string };

// Reached by a direct POST as well as from the page, so each action checks the couple first.
const viewerId = zod.uuid();
const MALFORMED = "Enter an email address like name@example.com";

/**
 * Lets someone read the Replies list and download it (a viewer). They also need letting through
 * Cloudflare Access, which the page says. A couple's address is refused: it already has everything.
 */
export async function addViewerAction(form: FormData): Promise<PeopleResult> {
  const admin = await requireAdmin();
  const typed = form.get("email");
  const email = typeof typed === "string" ? emailForAccess(typed) : "";
  if (!zod.email().safeParse(email).success) return { ok: false, error: MALFORMED };
  if (coupleEmails()?.includes(email)) return { ok: false, error: "That's one of the couple's addresses: it already has everything." };
  const result = await addViewer(email, admin.email);
  if (result.status === "already-viewer") return { ok: false, error: `${email} is already a viewer.` };
  refresh();
  return { ok: true, message: `Added ${email}. They can open the admin once Cloudflare Access lets them in too.` };
}

/** Takes view-only access away; their next page or download is refused. */
export async function removeViewerAction(id: string): Promise<PeopleResult> {
  const admin = await requireAdmin();
  if (!viewerId.safeParse(id).success) return { ok: false, error: "That viewer isn't on the list. Reload the page." };
  if ((await removeViewer(id, admin.email)) === "not-found") return { ok: false, error: "That viewer was already removed. Reload the page." };
  refresh();
  return { ok: true, message: "Removed. They can no longer open the admin." };
}
