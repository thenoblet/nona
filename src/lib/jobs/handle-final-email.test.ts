import { beforeEach, describe, expect, it, vi } from "vitest";
import { getFinalEmail, queueFinalEmails, queueTestEmail } from "@/lib/data/final-emails";
import { saveRsvp } from "@/lib/data/rsvp";
import { emailKey } from "@/lib/rsvp/normalize";
import { resetDb } from "../../../test/db";

const send = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/email/send", () => ({
  sendEmail: (message: unknown) => send.fn(message),
}));
vi.mock("@/lib/content/store", async () => {
  const { contentDefaults } = await import("@/lib/content/defaults");
  return { readSiteContent: async () => contentDefaults };
});

import { handleFinalEmail } from "./handle-final-email";

const attempt = { retryCount: 0, retryLimit: 13 };

async function queuedDetails(email = "ama@example.com") {
  const { record } = await saveRsvp({
    fullName: "Ama Owusu",
    phone: "024 000 0000",
    email,
    partySize: "Just me",
    answers: { ceremony: "yes" },
  });
  const { ids } = await queueFinalEmails("details", [{ reply: record, email, emailKey: emailKey(email) }], "couple@example.com");
  return ids[0];
}

beforeEach(async () => {
  await resetDb();
  send.fn.mockReset();
});

describe("handleFinalEmail", () => {
  it("sends the guest's email once, under a key of its kind and address, and marks it sent", async () => {
    const id = await queuedDetails();
    await handleFinalEmail(id, attempt);
    expect(send.fn).toHaveBeenCalledTimes(1);
    const message = send.fn.mock.calls[0][0];
    expect(message).toMatchObject({ to: "ama@example.com", idempotencyKey: "final/details/ama@example.com" });
    expect(message.text).toContain("Dear Ama Owusu,");
    expect(message.html).toContain("/my/");
    expect(await getFinalEmail(id)).toMatchObject({ status: "sent", error: null });
    // A second job for the same email sends nothing.
    await handleFinalEmail(id, attempt);
    expect(send.fn).toHaveBeenCalledTimes(1);
  });

  it("keeps an email queued while it retries, and marks it failed with the reason after the last try", async () => {
    const id = await queuedDetails();
    send.fn.mockRejectedValue(new Error("Too many requests"));
    await expect(handleFinalEmail(id, attempt)).rejects.toThrow();
    expect(await getFinalEmail(id)).toMatchObject({ status: "queued" });
    await expect(handleFinalEmail(id, { retryCount: 13, retryLimit: 13 })).rejects.toThrow();
    expect(await getFinalEmail(id)).toMatchObject({ status: "failed", error: "Error: Too many requests" });
  });

  it("sends a test to the couple, marked as a test, without the guest's personal link", async () => {
    const guestEmail = await queuedDetails();
    const reply = await getFinalEmail(guestEmail);
    const id = await queueTestEmail("details", "couple@example.com", reply!.rsvpId, "couple@example.com");
    await handleFinalEmail(id, attempt);
    const message = send.fn.mock.calls[0][0];
    expect(message.to).toBe("couple@example.com");
    expect(message.subject).toMatch(/^\[Test\] /);
    expect(message.html).not.toContain("/my/");
  });

  it("writes a test from a sample guest when nobody has replied that way yet", async () => {
    const id = await queueTestEmail("thanks", "couple@example.com", null, "couple@example.com");
    await handleFinalEmail(id, attempt);
    expect(send.fn.mock.calls[0][0].text).toContain("Dear Ama Owusu,");
  });
});
