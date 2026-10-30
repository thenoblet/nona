import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../../test/db";
import type { RsvpInput } from "./types";
import { listRsvps, rsvpHistories, rsvpHistory, rsvpTotals, saveRsvp } from "./rsvp";

const base: RsvpInput = {
  fullName: "Ama Owusu",
  phone: "024 000 0000",
  partySize: "Just me",
  answers: { ceremony: "yes", reception: "yes", thanks: "no" },
};

beforeEach(resetDb);

describe("saveRsvp replacement rules", () => {
  it("replaces a reply with the same name and phone", async () => {
    const first = await saveRsvp(base);
    expect(first.replaced).toBeNull();
    const second = await saveRsvp({ ...base, answers: { ceremony: "no" } });
    expect(second.replaced?.id).toBe(first.record.id);
    const current = await listRsvps();
    expect(current).toHaveLength(1);
    expect(current[0].answers).toEqual({ ceremony: "no" });
    const history = await rsvpHistory(second.record.id);
    expect(history.map((reply) => reply.id)).toContain(first.record.id);
  });

  it("matches names and phones after normalising", async () => {
    const first = await saveRsvp({ ...base, fullName: "  ama OWUSU ", phone: "+233 24 000 0000" });
    const second = await saveRsvp({ ...base, fullName: "Ama Owusu", phone: "024 000 0000" });
    expect(second.replaced?.id).toBe(first.record.id);
    expect(await listRsvps()).toHaveLength(1);
  });

  it("replaces on the same name and email when the phone differs", async () => {
    await saveRsvp({ ...base, email: "ama@example.com" });
    const second = await saveRsvp({ ...base, phone: "055 111 2222", email: "AMA@example.com" });
    expect(second.replaced).not.toBeNull();
    expect(await listRsvps()).toHaveLength(1);
  });

  it("keeps both when the same name has a different phone and no email match", async () => {
    await saveRsvp(base);
    const second = await saveRsvp({ ...base, phone: "055 111 2222" });
    expect(second.replaced).toBeNull();
    expect(await listRsvps()).toHaveLength(2);
  });

  it("keeps both for different names on one phone and flags them", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    const current = await listRsvps();
    expect(current).toHaveLength(2);
    expect(current.every((reply) => reply.possibleDuplicate)).toBe(true);
  });

  it("leaves unrelated replies unflagged", async () => {
    await saveRsvp(base);
    await saveRsvp({ ...base, fullName: "Kofi Mensah", phone: "055 111 2222" });
    expect((await listRsvps()).some((reply) => reply.possibleDuplicate)).toBe(false);
  });

  it("keeps one current reply when two identical saves race", async () => {
    await Promise.all([saveRsvp(base), saveRsvp(base)]);
    expect(await listRsvps()).toHaveLength(1);
  });
});

describe("rsvpTotals", () => {
  it("counts current replies only", async () => {
    await saveRsvp({ ...base, partySize: "4 or more" });
    await saveRsvp({ ...base, partySize: "2 people", answers: { ceremony: "yes", reception: "no" } });
    await saveRsvp({
      ...base,
      fullName: "Kofi Mensah",
      phone: "055 111 2222",
      partySize: "3 people",
      answers: { ceremony: "yes", thanks: "no" },
    });
    expect(await rsvpTotals()).toEqual({
      ceremony: { accepted: 2, declined: 0, people: 5 },
      reception: { accepted: 0, declined: 1, people: 0 },
      thanks: { accepted: 0, declined: 1, people: 0 },
    });
  });
});

describe("rsvpHistories", () => {
  it("gives a reply changed twice its full earlier history, newest first", async () => {
    const first = await saveRsvp({ ...base, partySize: "Just me" });
    const second = await saveRsvp({ ...base, partySize: "2 people" });
    const third = await saveRsvp({ ...base, partySize: "3 people" });
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

  it("follows a reply that replaced two earlier ones", async () => {
    // Same name on two phones stays as two replies until one reply matches both (phone and email).
    const byPhone = await saveRsvp(base);
    const byEmail = await saveRsvp({ ...base, phone: "055 111 2222", email: "ama@example.com" });
    const merged = await saveRsvp({ ...base, email: "ama@example.com" });
    const latest = await saveRsvp({ ...base, email: "ama@example.com", partySize: "2 people" });

    const histories = await rsvpHistories();
    expect(histories.get(latest.record.id)?.map((reply) => reply.id)).toEqual([
      merged.record.id,
      byEmail.record.id,
      byPhone.record.id,
    ]);
    expect(histories.size).toBe(1);
  });

  it("is empty when nothing was changed", async () => {
    await saveRsvp(base);
    expect((await rsvpHistories()).size).toBe(0);
  });
});
