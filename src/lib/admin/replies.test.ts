import { describe, expect, it } from "vitest";
import type { RsvpRecord } from "@/lib/data/types";
import {
  accraDate,
  celebrationDay,
  countByFilter,
  duplicateMatches,
  duplicateNote,
  matchesFilter,
  matchesSearch,
  receivedLabel,
  replyCsvRows,
  toReplyRows,
} from "./replies";

const celebrations = [
  { id: "ceremony" as const, name: "White wedding" },
  { id: "reception" as const, name: "Reception" },
  { id: "thanks" as const, name: "Thanksgiving service" },
];

function reply(overrides: Partial<RsvpRecord> & Pick<RsvpRecord, "id" | "fullName">): RsvpRecord {
  return {
    phone: "024 000 0000",
    partySize: "Just me",
    answers: { ceremony: "yes", reception: "yes", thanks: "no" },
    receivedAt: "2026-10-29T09:41:00.000Z",
    supersededAt: null,
    emailStatus: "none",
    possibleDuplicate: false,
    ...overrides,
  };
}

const now = new Date("2026-10-30T12:00:00Z");

describe("duplicateMatches", () => {
  it("names the other reply that shares a phone, after normalising", () => {
    const matches = duplicateMatches([
      reply({ id: "kofi-ansah", fullName: "Kofi Ansah", phone: "+233 24 000 0000" }),
      reply({ id: "kofi-ansa", fullName: "Kofi Ansa", phone: "024 000 0000" }),
    ]);
    expect(matches.get("kofi-ansah")).toEqual([{ name: "Kofi Ansa", same: "phone" }]);
    expect(matches.get("kofi-ansa")).toEqual([{ name: "Kofi Ansah", same: "phone" }]);
  });

  it("names the other reply that shares an email, ignoring case", () => {
    const matches = duplicateMatches([
      reply({ id: "ama", fullName: "Ama Owusu", email: "family@example.com" }),
      reply({ id: "kwame", fullName: "Kwame Owusu", phone: "055 111 2222", email: "Family@Example.com" }),
    ]);
    expect(matches.get("ama")).toEqual([{ name: "Kwame Owusu", same: "email" }]);
  });

  it("says both when the phone and the email match", () => {
    const matches = duplicateMatches([
      reply({ id: "ama", fullName: "Ama Owusu", email: "family@example.com" }),
      reply({ id: "kwame", fullName: "Kwame Owusu", email: "family@example.com" }),
    ]);
    expect(matches.get("ama")).toEqual([{ name: "Kwame Owusu", same: "phone and email" }]);
  });

  it("leaves unrelated replies and the same name on another phone alone", () => {
    const matches = duplicateMatches([
      reply({ id: "ama", fullName: "Ama Owusu" }),
      reply({ id: "ama-again", fullName: "AMA owusu", phone: "055 111 2222" }),
      reply({ id: "kofi", fullName: "Kofi Mensah", phone: "020 333 4444" }),
    ]);
    expect(matches.size).toBe(0);
  });

  it("writes the note shown under the guest", () => {
    expect(duplicateNote({ name: "Kofi Ansa", same: "phone" })).toBe("Possible duplicate of “Kofi Ansa” (same phone)");
  });
});

describe("receivedLabel", () => {
  it("says today or yesterday in Accra time, and the date before that", () => {
    expect(receivedLabel("2026-10-30T09:41:00Z", now)).toBe("Today 09:41");
    expect(receivedLabel("2026-10-29T21:15:00Z", now)).toBe("Yesterday 21:15");
    expect(receivedLabel("2026-10-27T18:02:00Z", now)).toBe("27 Oct, 18:02");
  });

  it("gives the Accra date for file names", () => {
    expect(accraDate(new Date("2026-10-30T23:59:00Z"))).toBe("2026-10-30");
  });

  it("writes a celebration's date as on the stat cards", () => {
    expect(celebrationDay("2026-12-05")).toBe("Sat 5 Dec");
  });
});

describe("toReplyRows", () => {
  it("adds labels, duplicate notes and each earlier reply, newest first", () => {
    const current = reply({ id: "ama", fullName: "Ama Owusu", song: "Odo", emailStatus: "failed" });
    const earlier = reply({
      id: "ama-before",
      fullName: "Ama Owusu",
      partySize: "2 people",
      answers: { ceremony: "yes", reception: "no" },
      song: "Odo by Kojo Antwi",
      receivedAt: "2026-10-28T18:02:00Z",
      supersededAt: "2026-10-29T09:41:00Z",
    });
    const [row] = toReplyRows([current], new Map([["ama", [earlier]]]), celebrations, now);
    expect(row.received).toBe("Yesterday 09:41");
    expect(row.emailStatus).toBe("failed");
    expect(row.earlier).toEqual([
      {
        id: "ama-before",
        received: "28 Oct, 18:02",
        details: ["2 people", "White wedding yes", "Reception no", "Song: Odo by Kojo Antwi"],
      },
    ]);
  });

  it("shows an earlier phone or email only when it differs from the current one", () => {
    const current = reply({ id: "ama", fullName: "Ama Owusu", email: "ama@example.com" });
    const earlier = reply({ id: "ama-before", fullName: "Ama Owusu", phone: "055 111 2222", email: "ama@example.com" });
    const [row] = toReplyRows([current], new Map([["ama", [earlier]]]), celebrations, now);
    expect(row.earlier[0].details).toContain("Phone: 055 111 2222");
    expect(row.earlier[0].details.join(" ")).not.toContain("ama@example.com");
  });
});

describe("filters and search", () => {
  const rows = toReplyRows(
    [
      reply({ id: "ama", fullName: "Akosua Ɔfori-Mensah", email: "akosua@example.com", emailStatus: "failed" }),
      reply({ id: "kofi", fullName: "Kofi Ansah", phone: "055 111 2222", answers: { ceremony: "no", thanks: "no" } }),
      reply({ id: "kofi-2", fullName: "Kofi Ansa", phone: "+233 55 111 2222", otherNames: "Esi Ansa" }),
    ],
    new Map(),
    celebrations,
    now,
  );

  it("counts each filter", () => {
    expect(countByFilter(rows)).toEqual({ all: 3, coming: 2, notComing: 1, duplicates: 2, emailFailed: 1 });
  });

  it("filters by coming, can't come, duplicates and failed email", () => {
    const ids = (filter: Parameters<typeof matchesFilter>[1]) =>
      rows.filter((row) => matchesFilter(row, filter)).map((row) => row.id);
    expect(ids("coming")).toEqual(["ama", "kofi-2"]);
    expect(ids("notComing")).toEqual(["kofi"]);
    expect(ids("duplicates")).toEqual(["kofi", "kofi-2"]);
    expect(ids("emailFailed")).toEqual(["ama"]);
  });

  it("finds a reply by name without accents or Ghanaian letters", () => {
    expect(rows.filter((row) => matchesSearch(row, "ofori")).map((row) => row.id)).toEqual(["ama"]);
    expect(rows.filter((row) => matchesSearch(row, "  KOFI  ")).map((row) => row.id)).toEqual(["kofi", "kofi-2"]);
    expect(rows.filter((row) => matchesSearch(row, "esi")).map((row) => row.id)).toEqual(["kofi-2"]);
  });

  it("finds a reply by phone in any format, and by email", () => {
    expect(rows.filter((row) => matchesSearch(row, "0551112222")).map((row) => row.id)).toEqual(["kofi", "kofi-2"]);
    expect(rows.filter((row) => matchesSearch(row, "+233 24")).map((row) => row.id)).toEqual(["ama"]);
    expect(rows.filter((row) => matchesSearch(row, "AKOSUA@")).map((row) => row.id)).toEqual(["ama"]);
    expect(rows.filter((row) => matchesSearch(row, "")).length).toBe(3);
  });
});

describe("replyCsvRows", () => {
  it("has a header row and one row per reply, with Accra times and plain labels", () => {
    const replies = [
      reply({
        id: "ama",
        fullName: "Ama Owusu",
        email: "ama@example.com",
        answers: { ceremony: "yes", thanks: "no" },
        otherNames: "Kojo Owusu",
        song: "Odo",
        receivedAt: "2026-10-29T23:30:00Z",
        emailStatus: "queued",
      }),
      reply({ id: "kwame", fullName: "Kwame Owusu" }),
    ];
    const rows = replyCsvRows(replies, celebrations);
    expect(rows[0]).toEqual([
      "Name",
      "Phone",
      "Email",
      "Party size",
      "White wedding",
      "Reception",
      "Thanksgiving service",
      "Other names",
      "Song",
      "Received",
      "Email status",
      "Possible duplicate",
    ]);
    expect(rows[1]).toEqual([
      "Ama Owusu",
      "024 000 0000",
      "ama@example.com",
      "Just me",
      "Yes",
      "",
      "No",
      "Kojo Owusu",
      "Odo",
      "2026-10-29 23:30",
      "Sending",
      "Kwame Owusu (same phone)",
    ]);
    expect(rows[2][10]).toBe("No email");
    expect(rows).toHaveLength(3);
  });
});
