import { beforeEach, describe, expect, it } from "vitest";
import { saveRsvp } from "@/lib/data/rsvp";
import { emailKey } from "@/lib/rsvp/normalize";
import { resetDb } from "../../../test/db";
import { listFinalEmails, queueFinalEmails, queueTestEmail, setWhatsappMark, whatsappMarks } from "./final-emails";

beforeEach(async () => {
  await resetDb();
});

async function recipient(name: string, email: string) {
  const { record } = await saveRsvp({ fullName: name, phone: "024 000 0000", email, partySize: "Just me", answers: { ceremony: "yes" } });
  return { reply: record, email, emailKey: emailKey(email) };
}

describe("queueFinalEmails", () => {
  it("queues each address once per kind, however often Send is pressed", async () => {
    const ama = await recipient("Ama", "ama@example.com");
    const first = await queueFinalEmails("details", [ama], "couple@example.com");
    expect(first.ids).toHaveLength(1);
    const kofi = await recipient("Kofi", "kofi@example.com");
    const again = await queueFinalEmails("details", [ama, kofi], "couple@example.com");
    expect(again.ids).toHaveLength(1);
    // The other kind is its own email.
    expect((await queueFinalEmails("thanks", [ama], "couple@example.com")).ids).toHaveLength(1);
    // Tests may repeat.
    await queueTestEmail("details", "couple@example.com", null, "couple@example.com");
    await queueTestEmail("details", "couple@example.com", null, "couple@example.com");
    const all = await listFinalEmails();
    expect(all.filter((email) => !email.test).map((email) => `${email.kind} ${email.email}`).toSorted()).toEqual([
      "details ama@example.com",
      "details kofi@example.com",
      "thanks ama@example.com",
    ]);
    expect(all.filter((email) => email.test)).toHaveLength(2);
  });
});

describe("WhatsApp ticks", () => {
  it("remembers who was sent the message on WhatsApp, per kind, until unticked", async () => {
    await setWhatsappMark("details", "0240000000", true, "couple@example.com");
    await setWhatsappMark("details", "0240000000", true, "couple@example.com");
    expect([...(await whatsappMarks())]).toEqual(["details:0240000000"]);
    await setWhatsappMark("details", "0240000000", false, "couple@example.com");
    expect(await whatsappMarks()).toEqual(new Set());
  });
});
