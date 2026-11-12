import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { guests, rsvps } from "@/lib/db/schema";
import { dbConfig } from "@/lib/env";
import { resetDb } from "../../../test/db";
import { findGuestById } from "./guests";
import type { RsvpInput } from "./types";
import {
  deleteReply,
  getRsvp,
  keepBoth,
  keepReply,
  listRsvps,
  rsvpHistories,
  rsvpHistory,
  rsvpTotals,
  saveRsvp,
} from "./rsvp";

const base: RsvpInput = {
  fullName: "Ama Owusu",
  phone: "024 000 0000",
  partySize: "Just me",
  answers: { ceremony: "yes", reception: "yes" },
};

beforeEach(resetDb);

/** Moves a reply's received time back, as if it had arrived that many minutes ago. */
async function receivedMinutesAgo(id: string, minutes: number): Promise<void> {
  await getDb().execute(
    sql`update rsvps set received_at = now() - make_interval(mins => ${minutes}) where id = ${id}`,
  );
}

async function flagsOf(id: string) {
  return (await listRsvps()).find((reply) => reply.id === id)?.flags;
}

describe("saveRsvp's received time", () => {
  it("is read once the reply holds its name's lock, so a reply that waited is never dated before the one it waited for", async () => {
    const holder = postgres({ ...dbConfig(), max: 1 });
    try {
      let saving: ReturnType<typeof saveRsvp> | undefined;
      let released = new Date(0);
      await holder.begin(async (transaction) => {
        await transaction`select pg_advisory_xact_lock(hashtext(${"ama owusu"}))`;
        saving = saveRsvp(base);
        await new Promise((resolve) => setTimeout(resolve, 300));
        [{ released }] = await transaction<{ released: Date }[]>`select clock_timestamp() as released`;
      });
      const { record } = await saving!;
      expect(new Date(record.receivedAt).getTime()).toBeGreaterThanOrEqual(released.getTime());
    } finally {
      await holder.end();
    }
  });
});

describe("saveRsvp keeps every reply", () => {
  it("keeps a second reply from the same name and phone, and flags both as replied again", async () => {
    const first = await saveRsvp({ ...base, fullName: "  ama OWUSU ", phone: "+233 24 000 0000" });
    const second = await saveRsvp({ ...base, fullName: "Ama Owusu", phone: "024 000 0000", answers: { ceremony: "no" } });

    const current = await listRsvps();
    expect(current.map((reply) => reply.id)).toEqual([second.record.id, first.record.id]);
    expect(await flagsOf(first.record.id)).toEqual([
      { kind: "replied-again", otherId: second.record.id, otherName: "Ama Owusu", via: "phone" },
    ]);
    expect(await flagsOf(second.record.id)).toEqual([
      { kind: "replied-again", otherId: first.record.id, otherName: "  ama OWUSU ", via: "phone" },
    ]);
  });

  it("flags the same name on another phone with the same email as replied again by email", async () => {
    const first = await saveRsvp({ ...base, email: "ama@example.com" });
    const second = await saveRsvp({ ...base, phone: "055 111 2222", email: "AMA@example.com", partySize: "2 people" });
    expect(await flagsOf(second.record.id)).toEqual([
      { kind: "replied-again", otherId: first.record.id, otherName: "Ama Owusu", via: "email" },
    ]);
  });

  it("flags a different name on the same phone as a possible duplicate", async () => {
    const ama = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    expect(await listRsvps()).toHaveLength(2);
    expect(await flagsOf(ama.record.id)).toEqual([
      { kind: "possible-duplicate", otherId: kofi.record.id, otherName: "Kofi Mensah", via: "phone" },
    ]);
    expect(await flagsOf(kofi.record.id)).toEqual([
      { kind: "possible-duplicate", otherId: ama.record.id, otherName: "Ama Owusu", via: "phone" },
    ]);
  });

  it("leaves unrelated replies, and the same name on another phone and email, unflagged", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, fullName: "Kofi Mensah", phone: "055 111 2222" });
    await saveRsvp({ ...base, phone: "020 333 4444", partySize: "2 people" });
    const current = await listRsvps();
    expect(current).toHaveLength(3);
    expect(current.every((reply) => reply.flags.length === 0)).toBe(true);
  });

  it("treats the same reply sent again within 10 minutes as one reply", async () => {
    const first = await saveRsvp({ ...base, email: "ama@example.com", song: "Odo" });
    const again = await saveRsvp({ ...base, fullName: " AMA owusu", phone: "+233 24 000 0000", email: "Ama@Example.com", song: "Odo" });
    expect(again.record.id).toBe(first.record.id);
    expect(await listRsvps()).toHaveLength(1);
  });

  it("compares a send with the guest's newest reply only: yes, no, then yes again is three replies", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, answers: { ceremony: "no", reception: "yes" } });
    const third = await saveRsvp(base);
    const current = await listRsvps();
    expect(current).toHaveLength(3);
    expect(current[0].id).toBe(third.record.id);
    expect(current[0].answers.ceremony).toBe("yes");
  });

  it("keeps one current reply when two identical saves race", async () => {
    await Promise.all([saveRsvp(base), saveRsvp(base)]);
    expect(await listRsvps()).toHaveLength(1);
  });

  it("keeps the same content sent 11 minutes later as a second reply", async () => {
    const first = await saveRsvp(base);
    await receivedMinutesAgo(first.record.id, 11);
    const second = await saveRsvp(base);
    expect(second.record.id).not.toBe(first.record.id);
    expect(await listRsvps()).toHaveLength(2);
  });

  it("keeps a reply that differs in any answer, even within 10 minutes", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, otherNames: "Kojo Owusu" });
    await saveRsvp({ ...base, answers: { ceremony: "yes", reception: "no" } });
    expect(await listRsvps()).toHaveLength(3);
  });

  it("keeps a reply sent again without the thanksgiving answer the guest's earlier reply had, within 10 minutes, and flags both as replied again", async () => {
    // Ama first replied while guests were still asked to the thanksgiving.
    const earlier = await saveRsvp({ ...base, answers: { ceremony: "yes", reception: "yes", thanks: "yes" } });
    const again = await saveRsvp({ ...base, answers: { ceremony: "yes", reception: "yes" } });

    expect(again.record.id).not.toBe(earlier.record.id);
    const current = await listRsvps();
    expect(current.map((reply) => reply.id)).toEqual([again.record.id, earlier.record.id]);
    expect(current.map((reply) => reply.answers)).toEqual([
      { ceremony: "yes", reception: "yes" },
      { ceremony: "yes", reception: "yes", thanks: "yes" },
    ]);
    expect(await flagsOf(earlier.record.id)).toEqual([
      { kind: "replied-again", otherId: again.record.id, otherName: "Ama Owusu", via: "phone" },
    ]);
    expect(await flagsOf(again.record.id)).toEqual([
      { kind: "replied-again", otherId: earlier.record.id, otherName: "Ama Owusu", via: "phone" },
    ]);
  });
});

describe("saveRsvp's guest (Ruling CB)", () => {
  async function guestRows() {
    return getDb().select().from(guests);
  }

  it("gives a new reply a guest of its own, named after it, whose link only the reply knows", async () => {
    const { record } = await saveRsvp({ ...base, fullName: "  Ama Owusu ", email: "ama@example.com" });
    expect(record.guestId).toEqual(expect.any(String));
    expect((await getRsvp(record.id))?.guestId).toBe(record.guestId);
    expect((await findGuestById(record.guestId!))?.displayName).toBe("Ama Owusu");
    expect(await guestRows()).toHaveLength(1);
  });

  it.each(["bit.ly/x", "Claim your gift at evil.example", "see http://evil.test", "a@evil.test", "a&b.com", "Call 024 000 0000", "A".repeat(61)])(
    "leaves the guest of a reply named %s unnamed: only a plain name is shown back (Ruling CC)",
    async (fullName) => {
      const { record } = await saveRsvp({ ...base, fullName });
      expect((await findGuestById(record.guestId!))?.displayName).toBeNull();
    },
  );

  it.each(["Akosua Ɔfori-Atta", "Ámà Owusu-Ansah", "Kwame Mensah Jr.", "Mr & Mrs Mensah", "Mensah, Kofi"])("names the guest of a reply named %s", async (fullName) => {
    const { record } = await saveRsvp({ ...base, fullName });
    expect((await findGuestById(record.guestId!))?.displayName).toBe(fullName);
  });

  it("gives every reply its own guest, the same person's second reply too, and a reply without an email", async () => {
    const first = await saveRsvp({ ...base, email: "ama@example.com" });
    const second = await saveRsvp({ ...base, email: "ama@example.com", partySize: "2 people" });
    const withoutEmail = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    const guestIds = [first, second, withoutEmail].map(({ record }) => record.guestId);
    expect(new Set(guestIds).size).toBe(3);
    expect(await guestRows()).toHaveLength(3);
  });

  it("answers the same reply sent again with the first one and its guest, making no second guest", async () => {
    const sent = await saveRsvp(base);
    const again = await saveRsvp(base);
    expect(again.record.id).toBe(sent.record.id);
    expect(again.record.guestId).toBe(sent.record.guestId);
    expect(await guestRows()).toHaveLength(1);
  });

  it("makes one guest for two identical replies sent at once", async () => {
    await Promise.all([saveRsvp(base), saveRsvp(base)]);
    expect(await listRsvps()).toHaveLength(1);
    expect(await guestRows()).toHaveLength(1);
  });

  it("reads a reply sent before personal links as having no guest", async () => {
    const { record } = await saveRsvp(base);
    await getDb().update(rsvps).set({ guestId: null });
    expect((await getRsvp(record.id))?.guestId).toBeUndefined();
  });
});

describe("keepReply", () => {
  it("moves every reply flagged against it into its history", async () => {
    const older = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    const unrelated = await saveRsvp({ ...base, fullName: "Esi Ansa", phone: "055 111 2222" });

    expect(await keepReply(newer.record.id, [older.record.id, kofi.record.id])).toEqual({ ok: true, moved: 2 });
    expect((await listRsvps()).map((reply) => reply.id)).toEqual([unrelated.record.id, newer.record.id]);
    expect(await flagsOf(newer.record.id)).toEqual([]);
    expect((await rsvpHistory(newer.record.id)).map((reply) => reply.id).sort()).toEqual(
      [older.record.id, kofi.record.id].sort(),
    );
    expect((await getRsvp(older.record.id))?.supersededAt).not.toBeNull();
  });

  it("leaves a pair the couple chose to keep", async () => {
    const ama = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    await keepBoth(ama.record.id, kofi.record.id, "couple@example.com");
    expect(await keepReply(ama.record.id, [])).toEqual({ ok: true, moved: 0 });
    expect(await listRsvps()).toHaveLength(2);
  });

  it("refuses a reply that is already in another reply's history", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReply(newer.record.id, [older.record.id]);
    const result = await keepReply(older.record.id, [newer.record.id]);
    expect(result.ok).toBe(false);
    expect(await listRsvps()).toHaveLength(1);
  });

  it("keeps exactly one reply when both of a pair are kept at once", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    await Promise.all([keepReply(older.record.id, [newer.record.id]), keepReply(newer.record.id, [older.record.id])]);
    expect(await listRsvps()).toHaveLength(1);
  });
});

describe("deleteReply", () => {
  it("deletes a current reply with its whole history, and leaves its guest and every other reply", async () => {
    // Kept twice: the first moves into the second's history, then the second into the third's.
    const first = await saveRsvp(base);
    const second = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReply(second.record.id, [first.record.id]);
    const third = await saveRsvp({ ...base, partySize: "3 people" });
    await keepReply(third.record.id, [second.record.id]);
    const esi = await saveRsvp({ ...base, fullName: "Esi Ansa", phone: "055 111 2222" });

    expect(await deleteReply(third.record.id)).toEqual({ ok: true, deleted: 3 });
    for (const reply of [first, second, third]) expect(await getRsvp(reply.record.id)).toBeNull();
    expect((await listRsvps()).map((reply) => reply.id)).toEqual([esi.record.id]);
    expect((await rsvpTotals()).ceremony).toEqual({ accepted: 1, declined: 0, people: 1 });
    expect(await findGuestById(third.record.guestId!)).not.toBeNull();
  });

  it("takes its \"Keep both\" pairs with it", async () => {
    const ama = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    await keepBoth(ama.record.id, kofi.record.id, "couple@example.com");
    expect(await deleteReply(ama.record.id)).toEqual({ ok: true, deleted: 1 });
    expect(await flagsOf(kofi.record.id)).toEqual([]);
  });

  it("refuses a reply that does not exist or is in another reply's history, deleting nothing", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReply(newer.record.id, [older.record.id]);
    expect((await deleteReply(randomUUID())).ok).toBe(false);
    expect((await deleteReply(older.record.id)).ok).toBe(false);
    expect(await getRsvp(older.record.id)).not.toBeNull();
    expect(await listRsvps()).toHaveLength(1);
  });

  it("survives a loop of replaced replies", async () => {
    const ama = await saveRsvp(base);
    const older = await saveRsvp({ ...base, partySize: "2 people" });
    // A loop the app never makes: older points at ama, and a third points back at older.
    const loop = await saveRsvp({ ...base, partySize: "3 people" });
    await getDb().execute(sql`update rsvps set superseded_at = now(), superseded_by = ${ama.record.id} where id = ${older.record.id}`);
    await getDb().execute(sql`update rsvps set superseded_at = now(), superseded_by = ${older.record.id} where id = ${loop.record.id}`);
    await getDb().execute(sql`update rsvps set superseded_by = ${loop.record.id} where id = ${ama.record.id}`);
    expect(await deleteReply(ama.record.id)).toEqual({ ok: true, deleted: 3 });
  });
});

describe("keepBoth", () => {
  it("clears the flag for that pair only, whichever way round it is given", async () => {
    const ama = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    expect(await keepBoth(kofi.record.id, ama.record.id, "couple@example.com")).toEqual({ ok: true });
    expect(await keepBoth(ama.record.id, kofi.record.id, "couple@example.com")).toEqual({ ok: true });
    expect(await flagsOf(ama.record.id)).toEqual([]);
    const esi = await saveRsvp({ ...base, fullName: "Esi Owusu" });
    expect((await flagsOf(esi.record.id))?.map((flag) => flag.otherId)).toEqual([kofi.record.id, ama.record.id]);
  });

  it("refuses a reply that does not exist, or a reply paired with itself", async () => {
    const ama = await saveRsvp(base);
    expect((await keepBoth(ama.record.id, randomUUID(), "couple@example.com")).ok).toBe(false);
    expect((await keepBoth(ama.record.id, ama.record.id, "couple@example.com")).ok).toBe(false);
  });
});

describe("rsvpTotals", () => {
  it("counts every current reply, and none moved into a history", async () => {
    const first = await saveRsvp({ ...base, partySize: "4 or more" });
    const second = await saveRsvp({ ...base, partySize: "2 people", answers: { ceremony: "yes", reception: "no" } });
    // Kofi replied while guests were still asked to the thanksgiving.
    await saveRsvp({
      ...base,
      fullName: "Kofi Mensah",
      phone: "055 111 2222",
      partySize: "3 people",
      answers: { ceremony: "yes", thanks: "no" },
    });
    expect(await rsvpTotals()).toEqual({
      ceremony: { accepted: 3, declined: 0, people: 9 },
      reception: { accepted: 1, declined: 1, people: 4 },
      thanks: { accepted: 0, declined: 1, people: 0 },
    });

    await keepReply(second.record.id, [first.record.id]);
    expect((await getRsvp(first.record.id))?.supersededAt).not.toBeNull();
    expect(await rsvpTotals()).toEqual({
      ceremony: { accepted: 2, declined: 0, people: 5 },
      reception: { accepted: 0, declined: 1, people: 0 },
      thanks: { accepted: 0, declined: 1, people: 0 },
    });
  });
});

describe("rsvpHistories", () => {
  it("gives a reply kept twice its full earlier history, newest first", async () => {
    const first = await saveRsvp({ ...base, partySize: "Just me" });
    const second = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReply(second.record.id, [first.record.id]);
    const third = await saveRsvp({ ...base, partySize: "3 people" });
    await keepReply(third.record.id, [second.record.id]);
    const other = await saveRsvp({ ...base, fullName: "Kofi Mensah", phone: "055 111 2222" });

    const histories = await rsvpHistories();
    expect(histories.get(third.record.id)?.map((reply) => reply.id)).toEqual([
      second.record.id,
      first.record.id,
    ]);
    expect(histories.get(third.record.id)?.map((reply) => reply.partySize)).toEqual(["2 people", "Just me"]);
    expect(histories.has(other.record.id)).toBe(false);
    expect(histories.size).toBe(1);
  });

  it("follows a reply that absorbed two earlier ones", async () => {
    // One phone and one email: the merged reply matches both earlier ones.
    const byPhone = await saveRsvp(base);
    const byEmail = await saveRsvp({ ...base, phone: "055 111 2222", email: "ama@example.com" });
    const merged = await saveRsvp({ ...base, email: "ama@example.com" });
    expect(await keepReply(merged.record.id, [byEmail.record.id, byPhone.record.id])).toEqual({ ok: true, moved: 2 });
    const latest = await saveRsvp({ ...base, email: "ama@example.com", partySize: "2 people" });
    expect(await keepReply(latest.record.id, [merged.record.id])).toEqual({ ok: true, moved: 1 });

    const histories = await rsvpHistories();
    expect(histories.get(latest.record.id)?.map((reply) => reply.id)).toEqual([
      merged.record.id,
      byEmail.record.id,
      byPhone.record.id,
    ]);
    expect(histories.size).toBe(1);
  });

  it("survives a loop of replaced replies and a reply replaced by one that does not exist", async () => {
    const kept = await saveRsvp(base);
    const looped = await saveRsvp({ ...base, fullName: "Kofi Mensah", phone: "055 111 2222" });
    const loopedBack = await saveRsvp({ ...base, fullName: "Esi Ansa", phone: "020 333 4444" });
    const orphan = await saveRsvp({ ...base, fullName: "Yaw Boateng", phone: "027 555 6666" });
    const missingId = randomUUID();
    await getDb().execute(sql`
      update rsvps set superseded_at = now(), superseded_by = case id
        when ${looped.record.id}::uuid then ${loopedBack.record.id}::uuid
        when ${loopedBack.record.id}::uuid then ${looped.record.id}::uuid
        else ${missingId}::uuid end
      where id in (${looped.record.id}, ${loopedBack.record.id}, ${orphan.record.id})
    `);

    const histories = await rsvpHistories();
    expect(histories.size).toBe(0);
    expect((await listRsvps()).map((reply) => reply.id)).toEqual([kept.record.id]);
  });

  it("is empty when nothing was moved", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, partySize: "2 people" });
    expect((await rsvpHistories()).size).toBe(0);
  });
});
