import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { EventId } from "@/content/wedding";
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

/** The celebrations are fixed: their wording is editable, but exactly these three exist. */
const EVENT_IDS: EventId[] = ["ceremony", "reception", "thanks"];

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
        .where(inArray(rsvps.id, earlier.map((row) => row.id)));
    }

    const replaced =
      earlier.length > 0
        ? earlier.reduce((newest, row) => (newest.receivedAt > row.receivedAt ? newest : row))
        : null;
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

  const names = (keyOf: (row: Row) => string | null) => {
    const byKey = new Map<string, Set<string>>();
    for (const row of rows) {
      const key = keyOf(row);
      if (!key) continue;
      byKey.set(key, (byKey.get(key) ?? new Set()).add(row.nameKey));
    }
    return byKey;
  };
  const byPhone = names((row) => row.phoneKey);
  const byEmail = names((row) => row.emailKey);

  return rows.map((row) =>
    toRecord(
      row,
      (byPhone.get(row.phoneKey)?.size ?? 0) > 1 ||
        (row.emailKey !== null && (byEmail.get(row.emailKey)?.size ?? 0) > 1),
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
  return rows.map((row) => toRecord(row));
}

/**
 * Every changed reply's earlier versions, keyed by the current reply's id, newest first.
 * One query loads all replaced replies; the supersededBy links are then followed in memory,
 * through replies replaced more than once and replies that replaced two at a time.
 */
export async function rsvpHistories(): Promise<Map<string, RsvpRecord[]>> {
  const replaced = await getDb().select().from(rsvps).where(isNotNull(rsvps.supersededAt));

  const replacedBy = new Map<string, Row[]>();
  for (const row of replaced) {
    if (!row.supersededBy) continue;
    replacedBy.set(row.supersededBy, [...(replacedBy.get(row.supersededBy) ?? []), row]);
  }

  // A reply that replaced others but was never replaced itself is a current one.
  const replacedIds = new Set(replaced.map((row) => row.id));
  const histories = new Map<string, RsvpRecord[]>();
  for (const currentId of replacedBy.keys()) {
    if (replacedIds.has(currentId)) continue;
    const earlier: Row[] = [];
    const seen = new Set([currentId]);
    const toVisit = [currentId];
    while (toVisit.length > 0) {
      for (const row of replacedBy.get(toVisit.pop()!) ?? []) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        earlier.push(row);
        toVisit.push(row.id);
      }
    }
    earlier.sort((first, second) => second.receivedAt.getTime() - first.receivedAt.getTime());
    histories.set(currentId, earlier.map((row) => toRecord(row)));
  }
  return histories;
}

export async function rsvpTotals(): Promise<
  Record<EventId, { accepted: number; declined: number; people: number }>
> {
  const totals = Object.fromEntries(
    EVENT_IDS.map((id) => [id, { accepted: 0, declined: 0, people: 0 }]),
  ) as Record<EventId, { accepted: number; declined: number; people: number }>;

  const rows = await getDb().select().from(rsvps).where(isNull(rsvps.supersededAt));
  for (const row of rows) {
    for (const id of EVENT_IDS) {
      const answer = row.answers[id];
      if (answer === "yes") {
        totals[id].accepted += 1;
        totals[id].people += PEOPLE[row.partySize] ?? 1;
      } else if (answer === "no") {
        totals[id].declined += 1;
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

/**
 * Mark a reply queued and enqueue its job as one step, holding a lock per email address, so
 * replies sent at the same instant cannot pass the daily cap together. If `enqueue` throws, the
 * status change rolls back: a reply is never queued without a job.
 */
export async function queueWithinDailyLimit(
  id: string,
  key: string,
  limit: number,
  enqueue: () => Promise<void>,
): Promise<boolean> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext(${key}))`,
    );
    const alreadyQueued = await transaction
      .select({ id: rsvps.id })
      .from(rsvps)
      .where(
        and(
          eq(rsvps.emailKey, key),
          inArray(rsvps.emailStatus, ["queued", "sent"]),
          gt(rsvps.receivedAt, sql`now() - interval '24 hours'`),
        ),
      );
    if (alreadyQueued.length >= limit) return false;
    const claimed = await transaction
      .update(rsvps)
      .set({ emailStatus: "queued" })
      .where(and(eq(rsvps.id, id), eq(rsvps.emailStatus, "none")))
      .returning({ id: rsvps.id });
    if (claimed.length === 0) return false;
    await enqueue();
    return true;
  });
}
