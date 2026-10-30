import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { rsvpFlagDismissals } from "@/lib/db/schema";
import { listRsvps, rsvpHistories, saveRsvp } from "@/lib/data/rsvp";
import type { RsvpInput } from "@/lib/data/types";
import { resetDb } from "../../../../test/db";

const cache = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: cache.refresh }));

const admin = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/admin/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/admin/access")>();
  return {
    ...real,
    requireAdmin: async () => {
      if (!admin.allowed) throw new real.AdminAccessError();
      return { email: "couple@example.com" };
    },
  };
});

import { keepBothAction, keepReplyAction } from "./actions";

const base: RsvpInput = {
  fullName: "Ama Owusu",
  phone: "024 000 0000",
  partySize: "Just me",
  answers: { ceremony: "yes", reception: "yes" },
};

async function flagged() {
  return Object.fromEntries(
    (await listRsvps()).map((reply) => [reply.id, reply.flags.map((flag) => flag.otherId)]),
  );
}

beforeEach(async () => {
  await resetDb();
  admin.allowed = false;
  cache.refresh.mockClear();
});

describe("without the couple", () => {
  it("both actions throw and change nothing", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });

    await expect(keepReplyAction(newer.record.id)).rejects.toThrow("Admin access refused");
    await expect(keepBothAction(newer.record.id, older.record.id)).rejects.toThrow("Admin access refused");
    await expect(keepReplyAction("not-an-id")).rejects.toThrow("Admin access refused");

    expect(await flagged()).toEqual({
      [newer.record.id]: [older.record.id],
      [older.record.id]: [newer.record.id],
    });
    expect(await getDb().select().from(rsvpFlagDismissals)).toEqual([]);
    expect((await rsvpHistories()).size).toBe(0);
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("keepReplyAction", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  it("keeps the newer reply and moves the older one into its history", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });

    expect(await keepReplyAction(newer.record.id)).toEqual({ ok: true, moved: 1 });
    expect(await flagged()).toEqual({ [newer.record.id]: [] });
    expect((await rsvpHistories()).get(newer.record.id)?.map((reply) => reply.id)).toEqual([older.record.id]);
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("says so when the reply is already in another reply's history", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReplyAction(newer.record.id);

    const result = await keepReplyAction(older.record.id);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(await flagged()).toEqual({ [newer.record.id]: [] });
  });

  it("refuses an id that is not a reply's", async () => {
    expect(await keepReplyAction("not-an-id")).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe("keepBothAction", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  it("clears the flag for the pair, and a third matching reply is still flagged against both", async () => {
    const ama = await saveRsvp(base);
    const amaAgain = await saveRsvp({ ...base, partySize: "2 people" });

    expect(await keepBothAction(amaAgain.record.id, ama.record.id)).toEqual({ ok: true });
    expect(await keepBothAction(ama.record.id, amaAgain.record.id)).toEqual({ ok: true });
    expect(await flagged()).toEqual({ [amaAgain.record.id]: [], [ama.record.id]: [] });

    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    expect(await flagged()).toEqual({
      [kofi.record.id]: [amaAgain.record.id, ama.record.id],
      [amaAgain.record.id]: [kofi.record.id],
      [ama.record.id]: [kofi.record.id],
    });

    const dismissals = await getDb().select().from(rsvpFlagDismissals);
    expect(dismissals).toHaveLength(1);
    expect(dismissals[0].dismissedBy).toBe("couple@example.com");
    expect(cache.refresh).toHaveBeenCalledTimes(2);
  });

  it("refuses ids that are not replies', and a reply paired with itself", async () => {
    const ama = await saveRsvp(base);
    expect(await keepBothAction(ama.record.id, "not-an-id")).toEqual({ ok: false, error: expect.any(String) });
    expect(await keepBothAction(ama.record.id, ama.record.id)).toEqual({ ok: false, error: expect.any(String) });
    expect(await getDb().select().from(rsvpFlagDismissals)).toEqual([]);
  });
});
