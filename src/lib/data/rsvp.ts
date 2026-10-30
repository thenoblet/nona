import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { EVENT_IDS, type EventId } from "@/lib/content/schema";
import { getDb } from "@/lib/db/client";
import { rsvpFlagDismissals, rsvps } from "@/lib/db/schema";
import { emailKey, nameKey, phoneKey } from "@/lib/rsvp/normalize";
import type { RsvpFlag, RsvpInput, RsvpRecord } from "./types";

type Row = typeof rsvps.$inferSelect;
type Dismissal = { rsvpId: string; otherRsvpId: string };

function toRecord(row: Row, flags: RsvpFlag[] = []): RsvpRecord {
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
    flags,
  };
}

const PEOPLE: Record<string, number> = {
  "Just me": 1,
  "2 people": 2,
  "3 people": 3,
  "4 or more": 4,
};

/**
 * Saves a reply as its own current reply: a second reply never replaces the first, the couple
 * chooses between them in the admin. A send identical to the guest's newest current reply (same
 * name, phone, email, party size, answers, other names and song, compared as keys) within 10
 * minutes of it is a double tap and returns that reply, so it gets no second confirmation email.
 * Only the newest counts: yes, then no, then yes again is three replies. The advisory lock makes
 * two simultaneous submissions for one name run one after the other.
 */
export async function saveRsvp(input: RsvpInput): Promise<{ record: RsvpRecord }> {
  const guestName = nameKey(input.fullName);
  const guestPhone = phoneKey(input.phone);
  const email = input.email?.trim() || null;
  const guestEmail = email ? emailKey(email) : null;
  const otherNames = input.otherNames ?? null;
  const song = input.song ?? null;

  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${guestName}))`);

    const sameGuest = guestEmail
      ? or(eq(rsvps.phoneKey, guestPhone), eq(rsvps.emailKey, guestEmail))
      : eq(rsvps.phoneKey, guestPhone);
    const [newest] = await transaction
      .select({
        reply: rsvps,
        repeated: sql<boolean>`(
          ${rsvps.phoneKey} = ${guestPhone}
          and ${rsvps.emailKey} is not distinct from ${guestEmail}
          and ${rsvps.partySize} = ${input.partySize}
          and ${rsvps.answers} = ${JSON.stringify(input.answers)}::jsonb
          and ${rsvps.otherNames} is not distinct from ${otherNames}
          and ${rsvps.song} is not distinct from ${song}
          and ${rsvps.receivedAt} > now() - interval '10 minutes'
        )`,
      })
      .from(rsvps)
      .where(and(eq(rsvps.nameKey, guestName), isNull(rsvps.supersededAt), sameGuest))
      .orderBy(desc(rsvps.receivedAt), desc(rsvps.id))
      .limit(1);
    if (newest?.repeated) return { record: toRecord(newest.reply) };

    const [created] = await transaction
      .insert(rsvps)
      .values({
        fullName: input.fullName,
        nameKey: guestName,
        phone: input.phone,
        phoneKey: guestPhone,
        email,
        emailKey: guestEmail,
        partySize: input.partySize,
        answers: input.answers,
        otherNames,
        song,
        // The time now, with the lock held, not when the transaction began: a reply that waited
        // for the lock is never dated before the one it waited for.
        receivedAt: sql`clock_timestamp()`,
      })
      .returning();
    return { record: toRecord(created) };
  });
}

/** One reply by id, current or superseded. */
export async function getRsvp(id: string): Promise<RsvpRecord | null> {
  const [row] = await getDb().select().from(rsvps).where(eq(rsvps.id, id));
  return row ? toRecord(row) : null;
}

/** The same text for a pair whichever way round it is given. */
function pairKey(firstId: string, secondId: string): string {
  return firstId < secondId ? `${firstId} ${secondId}` : `${secondId} ${firstId}`;
}

function groupBy(rows: Row[], keyOf: (row: Row) => string | null): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return groups;
}

/**
 * For each of these current replies (newest first), the others that share its phone or email,
 * newest first, leaving out the pairs the couple chose to keep both of.
 */
function flagsByReply(rows: Row[], dismissals: Dismissal[]): Map<string, RsvpFlag[]> {
  const kept = new Set(dismissals.map((dismissal) => pairKey(dismissal.rsvpId, dismissal.otherRsvpId)));
  const position = new Map(rows.map((row, index) => [row.id, index]));
  const byPhone = groupBy(rows, (row) => row.phoneKey);
  const byEmail = groupBy(rows, (row) => row.emailKey);

  const flags = new Map<string, RsvpFlag[]>();
  for (const row of rows) {
    const samePhone = byPhone.get(row.phoneKey) ?? [];
    const sameEmail = row.emailKey ? (byEmail.get(row.emailKey) ?? []) : [];
    const others = [...new Set([...samePhone, ...sameEmail])]
      .filter((other) => other.id !== row.id && !kept.has(pairKey(row.id, other.id)))
      .sort((first, second) => position.get(first.id)! - position.get(second.id)!);
    flags.set(
      row.id,
      others.map((other) => ({
        kind: other.nameKey === row.nameKey ? "replied-again" : "possible-duplicate",
        otherId: other.id,
        otherName: other.fullName,
        via: samePhone.includes(other) ? "phone" : "email",
      })),
    );
  }
  return flags;
}

const dismissalColumns = { rsvpId: rsvpFlagDismissals.rsvpId, otherRsvpId: rsvpFlagDismissals.otherRsvpId };

/** Current replies, newest first, each with the other current replies to check it against. */
export async function listRsvps(): Promise<RsvpRecord[]> {
  const [rows, dismissals] = await Promise.all([
    getDb().select().from(rsvps).where(isNull(rsvps.supersededAt)).orderBy(desc(rsvps.receivedAt)),
    getDb().select(dismissalColumns).from(rsvpFlagDismissals),
  ]);
  const flags = flagsByReply(rows, dismissals);
  return rows.map((row) => toRecord(row, flags.get(row.id)));
}

export type KeepResult = { ok: true; moved: number } | { ok: false; error: string };

// "Keep this one" and "Keep both" run one at a time, so two replies kept at once can never
// each move the other into its history.
const KEEP_LOCK = "rsvp-keep";

export const REPLY_NOT_FOUND = "That reply could not be found. The page now shows the latest replies.";
export const NEW_REPLY_ARRIVED = "A new reply arrived; the page now shows it.";
const ALREADY_MOVED = "That reply was already moved into another reply's history. The page now shows the latest replies.";

/**
 * "Keep this one": the replies the couple saw flagged against this one (`expectedOtherIds`) move
 * into its history, if they are still current and still flagged. If another reply is flagged
 * against it now, one that arrived after the page was shown, nothing moves: the couple must see
 * it first.
 */
export async function keepReply(id: string, expectedOtherIds: string[]): Promise<KeepResult> {
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${KEEP_LOCK}))`);
    const [kept] = await transaction.select().from(rsvps).where(eq(rsvps.id, id));
    if (!kept) return { ok: false, error: REPLY_NOT_FOUND };
    if (kept.supersededAt) return { ok: false, error: ALREADY_MOVED };

    const sameGuest = kept.emailKey
      ? or(eq(rsvps.phoneKey, kept.phoneKey), eq(rsvps.emailKey, kept.emailKey))
      : eq(rsvps.phoneKey, kept.phoneKey);
    const matching = await transaction
      .select()
      .from(rsvps)
      .where(and(isNull(rsvps.supersededAt), sameGuest))
      .orderBy(desc(rsvps.receivedAt));
    const dismissals = await transaction
      .select(dismissalColumns)
      .from(rsvpFlagDismissals)
      .where(or(eq(rsvpFlagDismissals.rsvpId, id), eq(rsvpFlagDismissals.otherRsvpId, id)));
    const flagged = (flagsByReply(matching, dismissals).get(id) ?? []).map((flag) => flag.otherId);
    const expected = new Set(expectedOtherIds);
    if (flagged.some((otherId) => !expected.has(otherId))) return { ok: false, error: NEW_REPLY_ARRIVED };
    if (flagged.length === 0) return { ok: true, moved: 0 };

    // Every flagged reply was on the page, so these are the listed ones still current and flagged.
    const moved = await transaction
      .update(rsvps)
      .set({ supersededAt: sql`now()`, supersededBy: id })
      .where(and(inArray(rsvps.id, flagged), isNull(rsvps.supersededAt)))
      .returning({ id: rsvps.id });
    return { ok: true, moved: moved.length };
  });
}

/** "Keep both": the pair stays unflagged from now on. Saving the same pair again changes nothing. */
export async function keepBoth(
  id: string,
  otherId: string,
  dismissedBy: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (id === otherId) return { ok: false, error: REPLY_NOT_FOUND };
  return getDb().transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${KEEP_LOCK}))`);
    const pair = await transaction
      .select({ supersededAt: rsvps.supersededAt })
      .from(rsvps)
      .where(inArray(rsvps.id, [id, otherId]));
    if (pair.length < 2) return { ok: false, error: REPLY_NOT_FOUND };
    if (pair.some((reply) => reply.supersededAt)) return { ok: false, error: ALREADY_MOVED };

    await transaction
      .insert(rsvpFlagDismissals)
      .values({
        rsvpId: sql`least(${id}::uuid, ${otherId}::uuid)`,
        otherRsvpId: sql`greatest(${id}::uuid, ${otherId}::uuid)`,
        dismissedBy,
      })
      .onConflictDoNothing();
    return { ok: true };
  });
}

/** The earlier replies moved into this one's history, newest first. */
export async function rsvpHistory(id: string): Promise<RsvpRecord[]> {
  const rows = await getDb()
    .select()
    .from(rsvps)
    .where(eq(rsvps.supersededBy, id))
    .orderBy(desc(rsvps.receivedAt));
  return rows.map((row) => toRecord(row));
}

/**
 * Every current reply's history, keyed by its id, newest first. One query loads the moved replies
 * and the current replies they point at; the supersededBy links are then followed in memory,
 * through replies moved more than once and replies that took in two at a time. A link to a reply
 * that does not exist, or a loop of links, shows nowhere.
 */
export async function rsvpHistories(): Promise<Map<string, RsvpRecord[]>> {
  const replaced = alias(rsvps, "replaced");
  const rows = await getDb()
    .select()
    .from(rsvps)
    .where(
      or(
        isNotNull(rsvps.supersededAt),
        inArray(
          rsvps.id,
          getDb().select({ id: replaced.supersededBy }).from(replaced).where(isNotNull(replaced.supersededBy)),
        ),
      ),
    );

  const replacedBy = new Map<string, Row[]>();
  for (const row of rows) {
    if (!row.supersededAt || !row.supersededBy) continue;
    replacedBy.set(row.supersededBy, [...(replacedBy.get(row.supersededBy) ?? []), row]);
  }

  const histories = new Map<string, RsvpRecord[]>();
  for (const current of rows) {
    if (current.supersededAt) continue;
    const earlier: Row[] = [];
    const seen = new Set([current.id]);
    const toVisit = [current.id];
    while (toVisit.length > 0) {
      for (const row of replacedBy.get(toVisit.pop()!) ?? []) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        earlier.push(row);
        toVisit.push(row.id);
      }
    }
    earlier.sort((first, second) => second.receivedAt.getTime() - first.receivedAt.getTime());
    histories.set(current.id, earlier.map((row) => toRecord(row)));
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

/**
 * Current replies from the last 24 hours with an email but no confirmation queued, oldest first:
 * the daily cap held them back, their job could not be queued, or the server restarted before
 * it was. The job queue offers them to the daily cap again when it starts.
 */
export async function unsentConfirmationIds(): Promise<string[]> {
  const rows = await getDb()
    .select({ id: rsvps.id })
    .from(rsvps)
    .where(
      and(
        isNotNull(rsvps.email),
        eq(rsvps.emailStatus, "none"),
        isNull(rsvps.supersededAt),
        gt(rsvps.receivedAt, sql`now() - interval '24 hours'`),
      ),
    )
    .orderBy(rsvps.receivedAt, rsvps.id);
  return rows.map((row) => row.id);
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
