import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { adminViewers } from "@/lib/db/schema";

/** A person the couple let read the Replies list, now or before. */
export type AdminViewer = {
  id: string;
  email: string;
  addedAt: string;
  addedBy: string;
  removedAt: string | null;
  removedBy: string | null;
};

type Row = typeof adminViewers.$inferSelect;

function toViewer(row: Row): AdminViewer {
  return {
    id: row.id,
    email: row.email,
    addedAt: row.addedAt.toISOString(),
    addedBy: row.addedBy,
    removedAt: row.removedAt?.toISOString() ?? null,
    removedBy: row.removedBy,
  };
}

/** An email as Cloudflare Access emails are compared: trimmed and lowercased. */
export function emailForAccess(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether this email may read the Replies list now. */
export async function isViewer(email: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: adminViewers.id })
    .from(adminViewers)
    .where(and(eq(adminViewers.email, emailForAccess(email)), isNull(adminViewers.removedAt)))
    .limit(1);
  return rows.length > 0;
}

/** Everyone who has or had view-only access: current first, newest added first within each. */
export async function listViewers(): Promise<{ current: AdminViewer[]; removed: AdminViewer[] }> {
  const rows = await getDb().select().from(adminViewers).orderBy(desc(adminViewers.addedAt));
  const viewers = rows.map(toViewer);
  return {
    current: viewers.filter((viewer) => viewer.removedAt === null),
    removed: viewers
      .filter((viewer) => viewer.removedAt !== null)
      .sort((first, second) => (second.removedAt ?? "").localeCompare(first.removedAt ?? "")),
  };
}

export type AddViewerResult = { status: "added"; viewer: AdminViewer } | { status: "already-viewer" };

/** Lets this email read the Replies list. An email that already can is left as it is. */
export async function addViewer(email: string, addedBy: string): Promise<AddViewerResult> {
  const rows = await getDb()
    .insert(adminViewers)
    .values({ email: emailForAccess(email), addedBy })
    .onConflictDoNothing({ target: adminViewers.email, where: sql`${adminViewers.removedAt} is null` })
    .returning();
  return rows[0] ? { status: "added", viewer: toViewer(rows[0]) } : { status: "already-viewer" };
}

/** Takes view-only access away; the row stays, marked removed, for the record. */
export async function removeViewer(id: string, removedBy: string): Promise<"removed" | "not-found"> {
  const rows = await getDb()
    .update(adminViewers)
    .set({ removedAt: new Date(), removedBy })
    .where(and(eq(adminViewers.id, id), isNull(adminViewers.removedAt)))
    .returning({ id: adminViewers.id });
  return rows.length > 0 ? "removed" : "not-found";
}
