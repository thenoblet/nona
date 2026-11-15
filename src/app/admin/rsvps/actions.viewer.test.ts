import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAccessError } from "@/lib/admin/access";
import { addViewer } from "@/lib/data/admin-viewers";
import { listVersions } from "@/lib/content/store";
import { listRsvps, saveRsvp } from "@/lib/data/rsvp";
import { resetDb } from "../../../../test/db";

// The real access check, signed in as a viewer through the dev stand-in: nothing here is mocked
// that decides who may do what.
vi.mock("next/cache", () => ({ refresh: vi.fn(), updateTag: vi.fn(), cacheTag: vi.fn(), cacheLife: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn(), connection: async () => {} }));
vi.mock("@/lib/site-images/cards", () => ({ redrawRsvpCard: vi.fn(async () => {}) }));

import {
  closeRsvpsAction,
  deleteReplyAction,
  keepBothAction,
  keepReplyAction,
  reopenRsvpsAction,
  saveRsvpSettingsAction,
} from "./actions";

const reply = { phone: "024 000 0000", partySize: "Just me", answers: { ceremony: "yes" as const } };

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ADMIN_COUPLE_EMAILS", "couple@example.com");
  vi.stubEnv("ADMIN_DEV_EMAIL", "viewer@example.com");
  await addViewer("viewer@example.com", "couple@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Replies actions, for a viewer", () => {
  it("refuse every change and leave the replies and settings as they were", async () => {
    const first = await saveRsvp({ ...reply, fullName: "Ama Owusu" });
    const second = await saveRsvp({ ...reply, fullName: "Ama Owusu" });
    const before = await listRsvps();
    const form = new FormData();
    form.set("open", "on");
    form.set("replyBy", "2026-11-30");
    form.set("closedMessage", "Closed");
    form.set("baseVersion", "0");

    const attempts = [
      () => keepReplyAction(second.record.id, [first.record.id]),
      () => keepBothAction(second.record.id, first.record.id),
      () => deleteReplyAction(first.record.id),
      () => closeRsvpsAction(0),
      () => reopenRsvpsAction(0),
      () => saveRsvpSettingsAction(form),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(AdminAccessError);

    expect(await listRsvps()).toEqual(before);
    expect(await listVersions("rsvp")).toEqual([]);
  });
});
