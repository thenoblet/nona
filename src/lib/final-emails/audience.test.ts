import { describe, expect, it } from "vitest";
import type { RsvpRecord } from "@/lib/data/types";
import { finalAudience, finalKindOf } from "./audience";

let counter = 0;
function reply(overrides: Partial<RsvpRecord>): RsvpRecord {
  counter += 1;
  return {
    id: `reply-${counter}`,
    fullName: `Guest ${counter}`,
    phone: "024 000 0000",
    partySize: "Just me",
    answers: { ceremony: "yes" },
    receivedAt: `2026-11-${String(10 + counter).padStart(2, "0")}T10:00:00.000Z`,
    supersededAt: null,
    emailStatus: "none",
    flags: [],
    ...overrides,
  };
}

describe("finalKindOf", () => {
  it("is details for a guest coming to anything, thanks for one coming to nothing", () => {
    expect(finalKindOf({ answers: { ceremony: "yes", reception: "no" } })).toBe("details");
    expect(finalKindOf({ answers: { reception: "yes" } })).toBe("details");
    expect(finalKindOf({ answers: { ceremony: "no", reception: "no" } })).toBe("thanks");
    expect(finalKindOf({ answers: {} })).toBeNull();
  });
});

describe("finalAudience", () => {
  it("sends each guest coming one email by address, and the rest to WhatsApp", () => {
    const ama = reply({ fullName: "Ama", email: "ama@example.com" });
    const kofi = reply({ fullName: "Kofi", phone: "055 123 4567" });
    const yaw = reply({ fullName: "Yaw", email: "yaw@example.com", answers: { ceremony: "no", reception: "no" } });
    const coming = finalAudience([ama, kofi, yaw], "details");
    expect(coming.byEmail.map((recipient) => recipient.reply.fullName)).toEqual(["Ama"]);
    expect(coming.byWhatsapp).toEqual([{ reply: kofi, phoneKey: "0551234567" }]);
    expect(finalAudience([ama, kofi, yaw], "thanks").byEmail.map((recipient) => recipient.reply.fullName)).toEqual(["Yaw"]);
  });

  it("leaves out replies moved into another's history", () => {
    const old = reply({ email: "ama@example.com", supersededAt: "2026-11-20T10:00:00.000Z" });
    expect(finalAudience([old], "details").byEmail).toEqual([]);
  });

  it("gives an address shared by two replies one email, greeting the newest", () => {
    const older = reply({ fullName: "Mr Mensah", email: "Mensah@Example.com " });
    const newer = reply({ fullName: "Mrs Mensah", email: "mensah@example.com" });
    const audience = finalAudience([older, newer], "details");
    expect(audience.byEmail).toEqual([{ reply: newer, email: "mensah@example.com", emailKey: "mensah@example.com" }]);
    expect(audience.merged).toBe(1);
  });
});
