import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRsvp, keepReply, saveRsvp, setEmailStatus } from "@/lib/data/rsvp";
import { contentDefaults } from "@/lib/content/defaults";
import { resetDb } from "../../../test/db";

const send = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: (message: unknown) => send.fn(message),
}));
vi.mock("@/lib/content/store", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { readSiteContent: async () => contentDefaults };
});

import { handleRsvpConfirmation } from "./handle-rsvp-confirmation";

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

  it("sends the rendered email to the reply's address, once per reply, and marks it sent", async () => {
    const reply = await queued();
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).toHaveBeenCalledOnce();
    const message = send.fn.mock.calls[0][0];
    expect(message).toMatchObject({
      to: "ama@example.com",
      subject: "Your reply to Noblet & Nancy",
      idempotencyKey: `rsvp-confirmation/${reply.id}`,
    });
    expect(message.html).toContain("Dear Ama Test,");
    expect(message.text).toContain("Dear Ama Test,");
    expect(message.ics).toContain("BEGIN:VCALENDAR");
    expect((await getRsvp(reply.id))?.emailStatus).toBe("sent");
  });

  it("skips a reply moved into another reply's history", async () => {
    const old = await queued();
    const { record: kept } = await saveRsvp({ ...input, partySize: "2 people" });
    await keepReply(kept.id, [old.id]);
    await handleRsvpConfirmation(old.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("skips a reply without an email", async () => {
    const reply = await queued({ email: undefined });
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).not.toHaveBeenCalled();
  });

  it("rethrows a failure and stays queued while retries remain", async () => {
    const reply = await queued();
    send.fn.mockRejectedValue(new Error("provider down"));
    await expect(
      handleRsvpConfirmation(reply.id, { retryCount: 1, retryLimit: 5 }),
    ).rejects.toThrow("provider down");
    expect((await getRsvp(reply.id))?.emailStatus).toBe("queued");
  });

  it("marks failed on the last attempt and still rethrows", async () => {
    const reply = await queued();
    send.fn.mockRejectedValue(new Error("provider down"));
    await expect(
      handleRsvpConfirmation(reply.id, { retryCount: 5, retryLimit: 5 }),
    ).rejects.toThrow("provider down");
    expect((await getRsvp(reply.id))?.emailStatus).toBe("failed");
  });
});
