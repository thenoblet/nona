import "server-only";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { celebrations, type EventId } from "@/content/wedding";
import { getDb } from "@/lib/db/client";
import { rsvps } from "@/lib/db/schema";
import { emailKey, nameKey, phoneKey } from "@/lib/rsvp/normalize";
import type { RsvpInput, RsvpRecord } from "./types";

type Row = typeof rsvps.$inferSelect;

function toRecord(row: Row, possibleDuplicate = false): RsvpRecord {
  return {
    id: row.id,
    fullName: row.fullName,
    phone: row.phone,
    email: row.email ?? undefined,
    partySize: row.partySize,
    answers: row.answers,
    otherNames: row.otherNames ?? undefined,
    song: row.song ?? undefined,
    receivedAt: row.receivedAt.toISOString(),
    supersededAt: row.supersededAt?.toISOString() ?? null,
    emailStatus: row.emailStatus,
    possibleDuplicate,
  };
}

const PEOPLE: Record<string, number> = {
  "Just me": 1,
  "2 people": 2,
  "3 people": 3,
  "4 or more": 4,
};

/**
 * A new reply replaces an earlier current one only for the same name AND the
 * same phone or email. The advisory lock makes two simultaneous submissions
 * for one name run one after the other.
 */
export async function saveRsvp(
  input: RsvpInput,
): Promise<{ record: RsvpRecord; replaced: RsvpRecord | null }> {
  const nKey = nameKey(input.fullName);
  const pKey = phoneKey(input.phone);
  const email = input.email?.trim() || null;
  const eKey = email ? emailKey(email) : null;

  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${nKey}))`);

    const sameGuest = eKey
      ? or(eq(rsvps.phoneKey, pKey), eq(rsvps.emailKey, eKey))
      : eq(rsvps.phoneKey, pKey);
    const earlier = await tx
      .select()
      .from(rsvps)
      .where(and(eq(rsvps.nameKey, nKey), isNull(rsvps.supersededAt), sameGuest));

    const [created] = await tx
      .insert(rsvps)
      .values({
        fullName: input.fullName,
        nameKey: nKey,
        phone: input.phone,
        phoneKey: pKey,
        email,
        emailKey: eKey,
        partySize: input.partySize,
        answers: input.answers,
        otherNames: input.otherNames ?? null,
        song: input.song ?? null,
      })
      .returning();

    if (earlier.length > 0) {
      await tx
        .update(rsvps)
        .set({ supersededAt: created.receivedAt, supersededBy: created.id })
        .where(inArray(rsvps.id, earlier.map((r) => r.id)));
    }

    const replaced = earlier.length > 0 ? earlier.reduce((a, b) => (a.receivedAt > b.receivedAt ? a : b)) : null;
    return {
      record: toRecord(created),
      replaced: replaced ? toRecord({ ...replaced, supersededAt: created.receivedAt }) : null,
    };
  });
}

/** One reply by id, current or superseded. */
export async function getRsvp(id: string): Promise<RsvpRecord | null> {
  const [row] = await getDb().select().from(rsvps).where(eq(rsvps.id, id));
  return row ? toRecord(row) : null;
}

/** Current replies, newest first. */
export async function listRsvps(): Promise<RsvpRecord[]> {
  const rows = await getDb()
    .select()
    .from(rsvps)
    .where(isNull(rsvps.supersededAt))
    .orderBy(desc(rsvps.receivedAt));

  const names = (key: (r: Row) => string | null) => {
    const byKey = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      byKey.set(k, (byKey.get(k) ?? new Set()).add(r.nameKey));
    }
    return byKey;
  };
  const byPhone = names((r) => r.phoneKey);
  const byEmail = names((r) => r.emailKey);

  return rows.map((r) =>
    toRecord(
      r,
      (byPhone.get(r.phoneKey)?.size ?? 0) > 1 ||
        (r.emailKey !== null && (byEmail.get(r.emailKey)?.size ?? 0) > 1),
    ),
  );
}

/** The earlier replies this one replaced, newest first. */
export async function rsvpHistory(id: string): Promise<RsvpRecord[]> {
  const rows = await getDb()
    .select()
    .from(rsvps)
    .where(eq(rsvps.supersededBy, id))
    .orderBy(desc(rsvps.receivedAt));
  return rows.map((r) => toRecord(r));
}

export async function rsvpTotals(): Promise<
  Record<EventId, { accepted: number; declined: number; people: number }>
> {
  const totals = Object.fromEntries(
    celebrations.map((c) => [c.id, { accepted: 0, declined: 0, people: 0 }]),
  ) as Record<EventId, { accepted: number; declined: number; people: number }>;

  const rows = await getDb().select().from(rsvps).where(isNull(rsvps.supersededAt));
  for (const r of rows) {
    for (const c of celebrations) {
      const answer = r.answers[c.id];
      if (answer === "yes") {
        totals[c.id].accepted += 1;
        totals[c.id].people += PEOPLE[r.partySize] ?? 1;
      } else if (answer === "no") {
        totals[c.id].declined += 1;
      }
    }
  }
  return totals;
}

export async function setEmailStatus(id: string, status: RsvpRecord["emailStatus"]): Promise<void> {
  await getDb().update(rsvps).set({ emailStatus: status }).where(eq(rsvps.id, id));
}

/** Confirmation emails queued or sent to this address in the last 24 hours. */
export async function confirmationsSentToday(key: string): Promise<number> {
  const rows = await getDb()
    .select({ id: rsvps.id })
    .from(rsvps)
    .where(
      and(
        eq(rsvps.emailKey, key),
        inArray(rsvps.emailStatus, ["queued", "sent"]),
        gt(rsvps.receivedAt, sql`now() - interval '24 hours'`),
      ),
    );
  return rows.length;
}
