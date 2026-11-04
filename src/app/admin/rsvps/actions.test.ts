import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { rsvpFlagDismissals } from "@/lib/db/schema";
import { RELOAD } from "@/lib/admin/content";
import { contentDefaults } from "@/lib/content/defaults";
import { listVersions, readSection, saveSection } from "@/lib/content/store";
import { listRsvps, rsvpHistories, saveRsvp } from "@/lib/data/rsvp";
import type { RsvpInput } from "@/lib/data/types";
import { resetDb } from "../../../../test/db";

const cache = vi.hoisted(() => ({ refresh: vi.fn(), updateTag: vi.fn() }));
vi.mock("next/cache", () => ({
  refresh: cache.refresh,
  updateTag: cache.updateTag,
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

// after() runs its task once the response is sent: here, when a test says so.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({ after: (task: () => unknown) => void afterTasks.push(task), connection: async () => {} }));

// The RSVP link preview's redraw (Task 19), watched: the worker's queue is its own module's to test.
const cards = vi.hoisted(() => ({ redrawRsvpCard: vi.fn(async () => {}) }));
vi.mock("@/lib/site-images/cards", () => cards);

async function afterResponse(): Promise<void> {
  await Promise.all(afterTasks.splice(0).map((task) => task()));
}

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

import {
  closeRsvpsAction,
  keepBothAction,
  keepReplyAction,
  reopenRsvpsAction,
  saveRsvpSettingsAction,
} from "./actions";

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
  afterTasks.length = 0;
  cards.redrawRsvpCard.mockClear();
  admin.allowed = false;
  cache.refresh.mockClear();
  cache.updateTag.mockClear();
});

describe("without the couple", () => {
  it("both actions throw and change nothing", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });

    await expect(keepReplyAction(newer.record.id, [older.record.id])).rejects.toThrow("Admin access refused");
    await expect(keepBothAction(newer.record.id, older.record.id)).rejects.toThrow("Admin access refused");
    await expect(keepReplyAction("not-an-id", ["not-an-id"])).rejects.toThrow("Admin access refused");

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

  it("keeps the newer reply and moves the older one the page listed into its history", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });

    expect(await keepReplyAction(newer.record.id, [older.record.id])).toEqual({ ok: true, moved: 1 });
    expect(await flagged()).toEqual({ [newer.record.id]: [] });
    expect((await rsvpHistories()).get(newer.record.id)?.map((reply) => reply.id)).toEqual([older.record.id]);
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("says so when the reply is already in another reply's history", async () => {
    const older = await saveRsvp(base);
    const newer = await saveRsvp({ ...base, partySize: "2 people" });
    await keepReplyAction(newer.record.id, [older.record.id]);

    const result = await keepReplyAction(older.record.id, [newer.record.id]);
    expect(result).toEqual({ ok: false, error: expect.any(String) });
    expect(await flagged()).toEqual({ [newer.record.id]: [] });
  });

  it("refuses and moves nothing when a reply arrived after the page was shown", async () => {
    const ama = await saveRsvp(base);
    const amaAgain = await saveRsvp({ ...base, partySize: "2 people" });
    const listed = (await listRsvps()).find((reply) => reply.id === amaAgain.record.id)!.flags.map((flag) => flag.otherId);
    expect(listed).toEqual([ama.record.id]);
    const spouse = await saveRsvp({ ...base, fullName: "Kojo Owusu", partySize: "Just me" });

    expect(await keepReplyAction(amaAgain.record.id, listed)).toEqual({
      ok: false,
      error: "A new reply arrived; the page now shows it.",
    });
    expect(await flagged()).toEqual({
      [spouse.record.id]: [amaAgain.record.id, ama.record.id],
      [amaAgain.record.id]: [spouse.record.id, ama.record.id],
      [ama.record.id]: [spouse.record.id, amaAgain.record.id],
    });
    expect((await rsvpHistories()).size).toBe(0);
    // The page is re-rendered, so the new reply shows up flagged.
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("moves only the listed replies that are still flagged against it", async () => {
    const ama = await saveRsvp(base);
    const kofi = await saveRsvp({ ...base, fullName: "Kofi Mensah" });
    const amaAgain = await saveRsvp({ ...base, partySize: "2 people" });
    // Another tab kept both Kofi's reply and this one after the page listed them.
    await keepBothAction(amaAgain.record.id, kofi.record.id);

    expect(await keepReplyAction(amaAgain.record.id, [kofi.record.id, ama.record.id])).toEqual({ ok: true, moved: 1 });
    expect(await flagged()).toEqual({ [amaAgain.record.id]: [], [kofi.record.id]: [] });
    expect((await rsvpHistories()).get(amaAgain.record.id)?.map((reply) => reply.id)).toEqual([ama.record.id]);
  });

  it("refuses an id that is not a reply's, and a list that is not one", async () => {
    const ama = await saveRsvp(base);
    expect(await keepReplyAction("not-an-id", [])).toEqual({ ok: false, error: expect.any(String) });
    expect(await keepReplyAction(ama.record.id, ["not-an-id"])).toEqual({ ok: false, error: expect.any(String) });
    const tooMany = Array.from({ length: 51 }, () => ama.record.id);
    expect(await keepReplyAction(ama.record.id, tooMany)).toEqual({ ok: false, error: expect.any(String) });
    expect(await keepReplyAction(ama.record.id, "not-a-list" as unknown as string[])).toEqual({
      ok: false,
      error: expect.any(String),
    });
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

/** What the RSVP settings form posts: the reply-by date, the closed message and the version it loaded. */
function settingsForm(fields: { replyBy?: string; closedMessage?: string; baseVersion?: string }): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return form;
}

const closedSettings = { ...contentDefaults.rsvp, open: false };

describe("RSVP settings without the couple", () => {
  it("closing, reopening and saving all throw, and nothing is saved", async () => {
    const form = settingsForm({ replyBy: "2026-11-25", closedMessage: "Closed.", baseVersion: "0" });
    await expect(closeRsvpsAction(0)).rejects.toThrow("Admin access refused");
    await expect(reopenRsvpsAction(0)).rejects.toThrow("Admin access refused");
    await expect(saveRsvpSettingsAction(form)).rejects.toThrow("Admin access refused");

    expect(await listVersions("rsvp")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });
});

describe("RSVP settings", () => {
  beforeEach(() => {
    admin.allowed = true;
  });

  it("closing saves a new version with replies closed, keeps the date and message, and updates the site's cache", async () => {
    expect(await closeRsvpsAction(0)).toEqual({ status: "saved", errors: [], version: 1 });

    expect(await readSection("rsvp")).toEqual({ value: closedSettings, version: 1 });
    expect((await listVersions("rsvp"))[0].savedBy).toBe("couple@example.com");
    expect(cache.updateTag).toHaveBeenCalledOnce();
    expect(cache.updateTag).toHaveBeenCalledWith("site-content");
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("has the worker draw the RSVP link preview again after the response, its words being the date or 'closed' (Task 19)", async () => {
    await closeRsvpsAction(0);
    expect(cards.redrawRsvpCard).not.toHaveBeenCalled();
    await afterResponse();
    expect(cards.redrawRsvpCard).toHaveBeenCalledExactlyOnceWith("couple@example.com");
    await saveRsvpSettingsAction(settingsForm({ replyBy: "2026-11-25", closedMessage: "Closed.", baseVersion: "1" }));
    await afterResponse();
    expect(cards.redrawRsvpCard).toHaveBeenCalledTimes(2);
    // A refused save changes nothing, so nothing is redrawn.
    await closeRsvpsAction(0);
    await afterResponse();
    expect(cards.redrawRsvpCard).toHaveBeenCalledTimes(2);
  });

  it("reopening saves a new version with replies open, and updates the site's cache", async () => {
    await closeRsvpsAction(0);
    cache.updateTag.mockClear();
    cache.refresh.mockClear();

    expect(await reopenRsvpsAction(1)).toEqual({ status: "saved", errors: [], version: 2 });
    expect(await readSection("rsvp")).toEqual({ value: contentDefaults.rsvp, version: 2 });
    expect(cache.updateTag).toHaveBeenCalledWith("site-content");
    expect(cache.refresh).toHaveBeenCalledOnce();
  });

  it("saving the date and message keeps replies closed or open as they were", async () => {
    await closeRsvpsAction(0);
    cache.updateTag.mockClear();

    const form = settingsForm({ replyBy: "2026-11-25", closedMessage: "  We have closed replies.  ", baseVersion: "1" });
    expect(await saveRsvpSettingsAction(form)).toEqual({ status: "saved", errors: [], version: 2 });
    expect((await readSection("rsvp")).value).toEqual({
      open: false,
      replyBy: "2026-11-25",
      closedMessage: "We have closed replies.",
    });
    expect((await listVersions("rsvp"))[0].savedBy).toBe("couple@example.com");
    expect(cache.updateTag).toHaveBeenCalledWith("site-content");
  });

  it("refuses a date on or after the wedding and an empty message, and saves nothing", async () => {
    const result = await saveRsvpSettingsAction(settingsForm({ replyBy: "2026-12-05", closedMessage: " ", baseVersion: "0" }));
    expect(result).toEqual({
      status: "error",
      errors: ["rsvp.replyBy: Use a date before the wedding", "rsvp.closedMessage: Cannot be empty"],
    });
    expect(await listVersions("rsvp")).toEqual([]);
    expect(cache.updateTag).not.toHaveBeenCalled();
    expect(cache.refresh).not.toHaveBeenCalled();
  });

  it("refuses a close, a reopen or a save made from an older version, and says who saved since", async () => {
    await saveSection("rsvp", { ...contentDefaults.rsvp, replyBy: "2026-11-22" }, "nancy@example.com");
    const newer = /^nancy@example\.com saved a newer version at \d{2}:\d{2} on \d{1,2} [A-Z][a-z]{2}\. Reload to see it\.$/;

    for (const result of [
      await closeRsvpsAction(0),
      await reopenRsvpsAction(0),
      await saveRsvpSettingsAction(settingsForm({ replyBy: "2026-11-25", closedMessage: "Closed.", baseVersion: "0" })),
    ]) {
      expect(result.status).toBe("error");
      expect(result.errors).toEqual([expect.stringMatching(newer)]);
    }
    expect(await readSection("rsvp")).toEqual({ value: { ...contentDefaults.rsvp, replyBy: "2026-11-22" }, version: 1 });
    expect(cache.updateTag).not.toHaveBeenCalled();
  });

  it("asks for a reload when the version or a field is missing or not one", async () => {
    const reload = { status: "error", errors: [RELOAD] };
    expect(await closeRsvpsAction(-1)).toEqual(reload);
    expect(await reopenRsvpsAction(1.5)).toEqual(reload);
    expect(await saveRsvpSettingsAction(settingsForm({ replyBy: "2026-11-25", closedMessage: "Closed." }))).toEqual(reload);
    expect(await saveRsvpSettingsAction(settingsForm({ closedMessage: "Closed.", baseVersion: "0" }))).toEqual(reload);
    expect(await saveRsvpSettingsAction(settingsForm({ replyBy: "2026-11-25", baseVersion: "zero" }))).toEqual(reload);
    expect(await listVersions("rsvp")).toEqual([]);
  });
});
