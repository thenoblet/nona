import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getRsvp, keepReply, saveRsvp, setEmailStatus } from "@/lib/data/rsvp";
import { contentDefaults } from "@/lib/content/defaults";
import type { RsvpInput } from "@/lib/data/types";
import { renderRsvpConfirmation } from "@/lib/email/rsvp-confirmation";
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

async function queued(extra: Partial<RsvpInput> = {}) {
  const { record } = await saveRsvp({ ...input, ...extra });
  await setEmailStatus(record.id, "queued");
  return record;
}

describe("handleRsvpConfirmation", () => {
  beforeEach(async () => {
    send.fn.mockReset();
    send.fn.mockResolvedValue(undefined);
    vi.stubEnv("SITE_URL", "https://wedding.example.com");
    await resetDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("gives the reply's guest's personal link, from the site's address and the guest's token, in the html and the text", async () => {
    const guest = await createGuest("Ama Test");
    const reply = await queued({ guestId: guest.id });
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    const message = send.fn.mock.calls[0][0];
    const link = `https://wedding.example.com/my/${guest.linkToken}`;
    expect(message.html).toContain(`href="${link}"`);
    expect(message.text).toContain(link);
    expect(message.text).toContain("Use this link on the day to keep your photos together.");
  });

  it("sends the same email on every attempt: the link comes from the guest's saved token", async () => {
    const guest = await createGuest("Ama Test");
    const reply = await queued({ guestId: guest.id });
    send.fn.mockRejectedValueOnce(new Error("provider down"));
    await expect(handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 })).rejects.toThrow("provider down");
    await handleRsvpConfirmation(reply.id, { retryCount: 1, retryLimit: 5 });
    const [firstTry, retry] = send.fn.mock.calls.map((call) => call[0]);
    expect(retry).toEqual(firstTry);
    expect(retry.html).toContain(`/my/${guest.linkToken}`);
  });

  it("sends a reply with no guest, sent before personal links (or still queued then), the email it always had", async () => {
    const reply = await queued();
    expect(reply.guestId).toBeUndefined();
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    const message = send.fn.mock.calls[0][0];
    const today = await renderRsvpConfirmation((await getRsvp(reply.id))!, contentDefaults, "https://wedding.example.com");
    expect(message).toMatchObject({ html: today.html, text: today.text, ics: today.ics });
    expect(message.html).not.toContain("/my/");
    expect(message.text).not.toContain("/my/");
    expect((await getRsvp(reply.id))?.emailStatus).toBe("sent");
  });

  it("gives a guest who declined everything no link", async () => {
    const guest = await createGuest("Ama Test");
    const reply = await queued({ guestId: guest.id, answers: { [contentDefaults.celebrations[0].id]: "no" } });
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    const message = send.fn.mock.calls[0][0];
    expect(message.html).not.toContain("/my/");
    expect(message.text).not.toContain("/my/");
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
