import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveRsvp, getRsvp, setEmailStatus } from "@/lib/data/rsvp";
import { contentDefaults } from "@/lib/content/defaults";
import { resetDb } from "../../../test/db";

const send = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: (m: unknown) => send.fn(m) }));
vi.mock("@/lib/content/store", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { readSiteContent: async () => contentDefaults };
});

import { handleRsvpConfirmation } from "./rsvp-confirmation";

const input = {
  fullName: "Ama Test",
  phone: "024 000 0000",
  email: "ama@example.com",
  partySize: "Just me",
  answers: { [contentDefaults.celebrations[0].id]: "yes" as const },
};

async function queued(extra: Partial<typeof input> = {}) {
  const { record } = await saveRsvp({ ...input, ...extra });
  await setEmailStatus(record.id, "queued");
  return record;
}

describe("handleRsvpConfirmation", () => {
  beforeEach(async () => {
    send.fn.mockReset();
    send.fn.mockResolvedValue(undefined);
    await resetDb();
  });

  it("sends to the reply's email and marks it sent", async () => {
    const r = await queued();
    await handleRsvpConfirmation(r.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).toHaveBeenCalledOnce();
    expect(send.fn.mock.calls[0][0]).toMatchObject({ to: "ama@example.com" });
    expect((await getRsvp(r.id))?.emailStatus).toBe("sent");
  });

  it("skips a superseded reply", async () => {
    const old = await queued();
    await saveRsvp({ ...input, partySize: "2 people" });
    await handleRsvpConfirmation(old.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("skips a reply without an email", async () => {
    const r = await queued({ email: undefined });
    await handleRsvpConfirmation(r.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("rethrows a failure and stays queued while retries remain", async () => {
    const r = await queued();
    send.fn.mockRejectedValue(new Error("provider down"));
    await expect(
      handleRsvpConfirmation(r.id, { retryCount: 1, retryLimit: 5 }),
    ).rejects.toThrow("provider down");
    expect((await getRsvp(r.id))?.emailStatus).toBe("queued");
  });

  it("marks failed on the last attempt and still rethrows", async () => {
    const r = await queued();
    send.fn.mockRejectedValue(new Error("provider down"));
    await expect(
      handleRsvpConfirmation(r.id, { retryCount: 5, retryLimit: 5 }),
    ).rejects.toThrow("provider down");
    expect((await getRsvp(r.id))?.emailStatus).toBe("failed");
  });
});
