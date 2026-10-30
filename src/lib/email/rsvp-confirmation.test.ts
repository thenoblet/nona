import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import type { RsvpRecord } from "@/lib/data/types";
import { renderRsvpConfirmation } from "./rsvp-confirmation";

const [first, second, third] = contentDefaults.celebrations;

function record(
  answers: RsvpRecord["answers"],
  fullName = "Ama Test",
): RsvpRecord {
  return {
    id: "r1",
    fullName,
    phone: "024 000 0000",
    email: "ama@example.com",
    partySize: "Just me",
    answers,
    receivedAt: new Date().toISOString(),
    supersededAt: null,
    emailStatus: "queued",
    possibleDuplicate: false,
  };
}

describe("renderRsvpConfirmation", () => {
  const out = renderRsvpConfirmation(
    record({ [first.id]: "yes", [second.id]: "no" }),
    contentDefaults,
    "https://example.com",
  );

  it("has the subject and lists attending and not attending celebrations", () => {
    expect(out.subject).toBe("Your reply to Noblet & Nancy");
    expect(out.text).toContain(`${first.name}: Attending`);
    expect(out.text).toContain(`${second.name}: Not attending`);
    expect(out.text).toContain(first.place);
    expect(out.text).toContain(first.time);
    expect(out.text).not.toContain(third.name);
    expect(out.html).toContain("Not attending");
  });

  it("links to the form and carries the change note and sign-off", () => {
    expect(out.text).toContain("https://example.com/rsvp");
    expect(out.text).toContain(
      "Need to change something? Send a new reply with the same name and phone or email.",
    );
    expect(out.text.trim().endsWith("With love, Noblet & Nancy")).toBe(true);
  });

  it("builds a calendar file with accepted celebrations only", () => {
    expect(out.ics).toContain(`UID:${first.id}@nobletxnancy.com`);
    expect(out.ics).not.toContain(`UID:${second.id}@nobletxnancy.com`);
  });

  it("has no calendar file when every reply is no", () => {
    const none = renderRsvpConfirmation(
      record({ [first.id]: "no" }),
      contentDefaults,
      "https://example.com",
    );
    expect(none.ics).toBeNull();
  });

  it.each(["Ama Owusu", "Akosua Ɔfori", "J. Doe", "Kwame Mensah Jr."])(
    "greets %s by name",
    (name) => {
      const mail = renderRsvpConfirmation(
        record({ [first.id]: "yes" }, name),
        contentDefaults,
        "https://example.com",
      );
      expect(mail.text).toContain(`Dear ${name},`);
      expect(mail.html).toContain(`Dear ${name},`);
    },
  );

  it.each([
    "see http://evil.test",
    "visit www.evil.test",
    "a@evil.test",
    "bit.ly",
    "evil.com",
    "a.b.c",
    "пример.рф",
    "A".repeat(61),
  ])("greets a guest whose name is %s as a guest", (name) => {
    const mail = renderRsvpConfirmation(
      record({ [first.id]: "yes" }, name),
      contentDefaults,
      "https://example.com",
    );
    expect(mail.text).toContain("Dear guest,");
    expect(mail.html).toContain("Dear guest,");
    expect(mail.text).not.toContain(name);
  });
});
