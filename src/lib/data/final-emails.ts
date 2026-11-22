import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { finalEmails, finalWhatsapp } from "@/lib/db/schema";
import type { EmailRecipient, FinalKind } from "@/lib/final-emails/audience";

/** One final email as the admin and the job see it. */
export type FinalEmail = {
  id: string;
  kind: FinalKind;
  test: boolean;
  rsvpId: string | null;
  email: string;
  emailKey: string;
  batchId: string;
  status: "queued" | "sent" | "failed";
  error: string | null;
  queuedAt: string;
  queuedBy: string;
  sentAt: string | null;
};

type Row = typeof finalEmails.$inferSelect;

function toFinalEmail(row: Row): FinalEmail {
  return {
    id: row.id,
    kind: row.kind,
    test: row.test,
    rsvpId: row.rsvpId,
    email: row.email,
    emailKey: row.emailKey,
    batchId: row.batchId,
    status: row.status,
    error: row.error,
    queuedAt: row.queuedAt.toISOString(),
    queuedBy: row.queuedBy,
    sentAt: row.sentAt?.toISOString() ?? null,
  };
}

/**
 * Writes a row for each recipient who hasn't had this kind of email yet, as one batch, and returns
 * the new rows' ids for their jobs. Anyone already sent it, or queued, is left out: a guest gets
 * each kind once, however often Send is pressed.
 */
export async function queueFinalEmails(
  kind: FinalKind,
  recipients: readonly EmailRecipient[],
  queuedBy: string,
): Promise<{ batchId: string; ids: string[] }> {
  const batchId = randomUUID();
  if (recipients.length === 0) return { batchId, ids: [] };
  const rows = await getDb()
    .insert(finalEmails)
    .values(
      recipients.map((recipient) => ({
        kind,
        rsvpId: recipient.reply.id,
        email: recipient.email,
        emailKey: recipient.emailKey,
        batchId,
        queuedBy,
      })),
    )
    .onConflictDoNothing({ target: [finalEmails.kind, finalEmails.emailKey], where: sql`not ${finalEmails.test}` })
    .returning({ id: finalEmails.id });
  return { batchId, ids: rows.map((row) => row.id) };
}

/** A test the couple send themselves, written from `rsvpId`'s reply (or a sample with none). */
export async function queueTestEmail(kind: FinalKind, email: string, rsvpId: string | null, queuedBy: string): Promise<string> {
  const [row] = await getDb()
    .insert(finalEmails)
    .values({ kind, test: true, rsvpId, email, emailKey: email.trim().toLowerCase(), batchId: randomUUID(), queuedBy })
    .returning({ id: finalEmails.id });
  return row.id;
}

export async function getFinalEmail(id: string): Promise<FinalEmail | null> {
  const [row] = await getDb().select().from(finalEmails).where(eq(finalEmails.id, id));
  return row ? toFinalEmail(row) : null;
}

export async function markFinalEmailSent(id: string): Promise<void> {
  await getDb().update(finalEmails).set({ status: "sent", sentAt: new Date(), error: null }).where(eq(finalEmails.id, id));
}

export async function markFinalEmailFailed(id: string, error: string): Promise<void> {
  await getDb().update(finalEmails).set({ status: "failed", error: error.slice(0, 300) }).where(eq(finalEmails.id, id));
}

/** Every final email, tests included, newest first: the admin's progress, failures and history. */
export async function listFinalEmails(): Promise<FinalEmail[]> {
  const rows = await getDb().select().from(finalEmails).orderBy(desc(finalEmails.queuedAt), asc(finalEmails.email));
  return rows.map(toFinalEmail);
}

/** Emails still waiting, for the job queue to take up again when it starts. */
export async function queuedFinalEmailIds(): Promise<string[]> {
  const rows = await getDb().select({ id: finalEmails.id }).from(finalEmails).where(eq(finalEmails.status, "queued"));
  return rows.map((row) => row.id);
}

/** The guests without an email the couple ticked off as sent on WhatsApp, as "kind:phoneKey". */
export async function whatsappMarks(): Promise<Set<string>> {
  const rows = await getDb().select({ kind: finalWhatsapp.kind, phoneKey: finalWhatsapp.phoneKey }).from(finalWhatsapp);
  return new Set(rows.map((row) => `${row.kind}:${row.phoneKey}`));
}

export async function setWhatsappMark(kind: FinalKind, phoneKey: string, sent: boolean, markedBy: string): Promise<void> {
  if (sent) {
    await getDb().insert(finalWhatsapp).values({ kind, phoneKey, markedBy }).onConflictDoNothing();
  } else {
    await getDb()
      .delete(finalWhatsapp)
      .where(and(eq(finalWhatsapp.kind, kind), eq(finalWhatsapp.phoneKey, phoneKey)));
  }
}
