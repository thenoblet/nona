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

import {
  handleRsvpConfirmation,
  queueRsvpConfirmation,
} from "./rsvp-confirmation";

const queue = vi.hoisted(() => ({ send: vi.fn(), fail: false }));
vi.mock("./boss", () => ({
  QUEUES: { rsvpConfirmation: "email-rsvp-confirmation" },
  getBoss: async () => ({
    send: async (...args: unknown[]) => {
      if (queue.fail) throw new Error("queue is down for ama@example.com");
      queue.send(...args);
      return "job";
    },
  }),
}));

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
    const reply = await queued();
    await handleRsvpConfirmation(reply.id, { retryCount: 0, retryLimit: 5 });
    expect(send.fn).toHaveBeenCalledOnce();
    expect(send.fn.mock.calls[0][0]).toMatchObject({ to: "ama@example.com" });
    expect((await getRsvp(reply.id))?.emailStatus).toBe("sent");
  });

  it("skips a reply moved into another reply's history", async () => {
    const old = await queued();
    const { record: kept } = await saveRsvp({ ...input, partySize: "2 people" });
    await keepReply(kept.id);
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

describe("queueRsvpConfirmation", () => {
  beforeEach(async () => {
    queue.send.mockReset();
    queue.fail = false;
    await resetDb();
  });

  it("queues exactly three jobs when five replies share one email at once", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const { record } = await saveRsvp({
        ...input,
        fullName: `Guest ${index}`,
        phone: `024 000 000${index}`,
      });
      ids.push(record.id);
    }
    await Promise.all(ids.map((id) => queueRsvpConfirmation(id)));
    expect(queue.send).toHaveBeenCalledTimes(3);
    const statuses = await Promise.all(
      ids.map(async (id) => (await getRsvp(id))?.emailStatus),
    );
    expect(statuses.filter((status) => status === "queued")).toHaveLength(3);
    expect(statuses.filter((status) => status === "none")).toHaveLength(2);
  });

  it("leaves the reply at none when the job cannot be sent, and logs no address", async () => {
    queue.fail = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const reply = await saveRsvp(input).then((saved) => saved.record);
    await queueRsvpConfirmation(reply.id);
    expect((await getRsvp(reply.id))?.emailStatus).toBe("none");
    expect(JSON.stringify(log.mock.calls)).not.toContain("example.com");
    log.mockRestore();
  });
});
