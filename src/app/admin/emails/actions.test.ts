import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAccessError } from "@/lib/admin/access";
import { addViewer } from "@/lib/data/admin-viewers";
import { listFinalEmails, markFinalEmailFailed, whatsappMarks } from "@/lib/data/final-emails";
import { saveRsvp } from "@/lib/data/rsvp";
import { resetDb } from "../../../../test/db";

// The real access check, signed in through the dev stand-in; the job queue is a stand-in.
vi.mock("next/cache", () => ({ refresh: vi.fn(), updateTag: vi.fn(), cacheTag: vi.fn(), cacheLife: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn(), connection: async () => {} }));
const jobs = vi.hoisted(() => ({ queued: [] as string[], fail: false }));
vi.mock("@/lib/jobs/final-emails", () => ({
  queueFinalEmailJobs: async (ids: string[]) => {
    if (jobs.fail) throw new Error("queue down");
    jobs.queued.push(...ids);
  },
}));

import { markWhatsappAction, retryFailedAction, sendFinalEmailsAction, sendTestAction } from "./actions";

const reply = (fullName: string, email: string | undefined, coming: boolean) =>
  saveRsvp({
    fullName,
    phone: "024 000 0000",
    email,
    partySize: "Just me",
    answers: coming ? { ceremony: "yes" } : { ceremony: "no", reception: "no" },
  });

beforeEach(async () => {
  await resetDb();
  jobs.queued.length = 0;
  jobs.fail = false;
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ADMIN_COUPLE_EMAILS", "couple@example.com");
  vi.stubEnv("ADMIN_DEV_EMAIL", "couple@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the Emails actions", () => {
  it("send each guest coming one email, and only the new ones when Send is pressed again", async () => {
    await reply("Ama", "ama@example.com", true);
    await reply("Kofi", "kofi@example.com", false);
    await reply("Yaw", undefined, true);
    expect(await sendFinalEmailsAction("details")).toEqual({ ok: true, message: "Sending to 1 guest." });
    expect(jobs.queued).toHaveLength(1);
    expect(await sendFinalEmailsAction("details")).toEqual({ ok: true, message: "Everyone has had it already." });
    // A late reply gets it on the next press, and nobody else does.
    await reply("Esi", "esi@example.com", true);
    expect(await sendFinalEmailsAction("details")).toEqual({ ok: true, message: "Sending to 1 guest." });
    const sent = (await listFinalEmails()).map((email) => `${email.kind} ${email.email} ${email.queuedBy}`).toSorted();
    expect(sent).toEqual(["details ama@example.com couple@example.com", "details esi@example.com couple@example.com"]);
  });

  it("keep the emails when the queue is down, to go out when it's back", async () => {
    await reply("Ama", "ama@example.com", true);
    jobs.fail = true;
    const result = await sendFinalEmailsAction("details");
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.message).toContain("as soon as the email service is back");
    expect(await listFinalEmails()).toHaveLength(1);
  });

  it("send a test to the couple, and try the failed emails again", async () => {
    await reply("Ama", "ama@example.com", true);
    expect(await sendTestAction("details")).toEqual({ ok: true, message: "Sending a test to couple@example.com." });
    await sendFinalEmailsAction("details");
    const guest = (await listFinalEmails()).find((email) => !email.test)!;
    await markFinalEmailFailed(guest.id, "Invalid address");
    jobs.queued.length = 0;
    expect(await retryFailedAction("details")).toEqual({ ok: true, message: "Trying 1 email again." });
    expect(jobs.queued).toEqual([guest.id]);
  });

  it("tick a guest off as sent on WhatsApp", async () => {
    expect(await markWhatsappAction("thanks", "0240000000", true)).toMatchObject({ ok: true });
    expect(await whatsappMarks()).toEqual(new Set(["thanks:0240000000"]));
    expect(await markWhatsappAction("thanks", "not a number", true)).toMatchObject({ ok: false });
  });

  it("refuse a viewer everything, and change nothing", async () => {
    await addViewer("viewer@example.com", "couple@example.com");
    vi.stubEnv("ADMIN_DEV_EMAIL", "viewer@example.com");
    await reply("Ama", "ama@example.com", true);
    const attempts = [
      () => sendFinalEmailsAction("details"),
      () => sendTestAction("details"),
      () => retryFailedAction("details"),
      () => markWhatsappAction("details", "0240000000", true),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toBeInstanceOf(AdminAccessError);
    expect(await listFinalEmails()).toEqual([]);
    expect(jobs.queued).toEqual([]);
  });
});
