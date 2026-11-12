import { describe, expect, it } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import type { RsvpRecord } from "@/lib/data/types";
import {
  celebrationDay,
  countByFilter,
  emailStatusLabel,
  flagNote,
  matchesFilter,
  matchesSearch,
  receivedLabel,
  replyColumns,
  replyCsvRows,
  toReplyRows,
} from "./replies";

const celebrations = replyColumns(contentDefaults.celebrations);

function reply(overrides: Partial<RsvpRecord> & Pick<RsvpRecord, "id" | "fullName">): RsvpRecord {
  return {
    phone: "024 000 0000",
    partySize: "Just me",
    answers: { ceremony: "yes", reception: "yes", thanks: "no" },
    receivedAt: "2026-10-29T09:41:00.000Z",
    supersededAt: null,
    emailStatus: "none",
    flags: [],
    ...overrides,
  };
}

const now = new Date("2026-10-30T12:00:00Z");

describe("flagNote", () => {
  it("says who replied again, when in Accra, and which detail matched", () => {
    expect(
      flagNote({ kind: "replied-again", otherId: "ama-before", otherName: "Ama Owusu", via: "phone" }, "2026-10-28T18:02:00Z"),
    ).toBe("Replied again: also replied as Ama Owusu on 28 Oct, 18:02 (same phone)");
  });

  it("names a possible duplicate, when it was sent and the detail it shares", () => {
    expect(
      flagNote({ kind: "possible-duplicate", otherId: "kofi", otherName: "Kofi Ansa", via: "email" }, "2026-10-28T18:02:00Z"),
    ).toBe("Possible duplicate of Kofi Ansa on 28 Oct, 18:02 (same email)");
  });

  it("tells apart two possible duplicates with the same name by their dates", () => {
    const kofi = reply({
      id: "kofi",
      fullName: "Kofi Ansa",
      flags: [
        { kind: "possible-duplicate", otherId: "ama-later", otherName: "Ama Ansa", via: "phone" },
        { kind: "possible-duplicate", otherId: "ama-earlier", otherName: "Ama Ansa", via: "phone" },
      ],
    });
    const later = reply({ id: "ama-later", fullName: "Ama Ansa", receivedAt: "2026-10-29T08:15:00Z" });
    const earlier = reply({ id: "ama-earlier", fullName: "Ama Ansa", receivedAt: "2026-10-28T18:02:00Z" });
    const [row] = toReplyRows([kofi, later, earlier], new Map(), celebrations, now);
    expect(row.flags.map((flag) => flag.note)).toEqual([
      "Possible duplicate of Ama Ansa on 29 Oct, 08:15 (same phone)",
      "Possible duplicate of Ama Ansa on 28 Oct, 18:02 (same phone)",
    ]);
  });
});

describe("receivedLabel", () => {
  it("says today or yesterday in Accra time, and the date before that", () => {
    expect(receivedLabel("2026-10-30T09:41:00Z", now)).toBe("Today 09:41");
    expect(receivedLabel("2026-10-29T21:15:00Z", now)).toBe("Yesterday 21:15");
    expect(receivedLabel("2026-10-27T18:02:00Z", now)).toBe("27 Oct, 18:02");
  });

  it("writes a celebration's date as on the stat cards", () => {
    expect(celebrationDay("2026-12-05")).toBe("Sat 5 Dec");
  });
});

describe("toReplyRows", () => {
  it("adds labels and each earlier reply, newest first", () => {
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

  it("writes each flag as a note, dated from the other reply", () => {
    const ama = reply({
      id: "ama",
      fullName: "Ama Owusu",
      flags: [
        { kind: "replied-again", otherId: "ama-before", otherName: "AMA owusu", via: "phone" },
        { kind: "possible-duplicate", otherId: "kwame", otherName: "Kwame Owusu", via: "email" },
      ],
    });
    const amaBefore = reply({ id: "ama-before", fullName: "AMA owusu", receivedAt: "2026-10-28T18:02:00Z" });
    const kwame = reply({ id: "kwame", fullName: "Kwame Owusu", phone: "055 111 2222" });
    const [row] = toReplyRows([ama, amaBefore, kwame], new Map(), celebrations, now);
    expect(row.flags).toEqual([
      {
        kind: "replied-again",
        otherId: "ama-before",
        otherName: "AMA owusu",
        otherReceived: "28 Oct, 18:02",
        note: "Replied again: also replied as AMA owusu on 28 Oct, 18:02 (same phone)",
      },
      {
        kind: "possible-duplicate",
        otherId: "kwame",
        otherName: "Kwame Owusu",
        otherReceived: "29 Oct, 09:41",
        note: "Possible duplicate of Kwame Owusu on 29 Oct, 09:41 (same email)",
      },
    ]);
  });
});

describe("filters and search", () => {
  const rows = toReplyRows(
    [
      reply({ id: "ama", fullName: "Akosua Ɔfori-Mensah", email: "akosua@example.com", emailStatus: "failed" }),
      reply({
        id: "kofi",
        fullName: "Kofi Ansah",
        phone: "055 111 2222",
        answers: { ceremony: "no", thanks: "yes" },
        flags: [{ kind: "possible-duplicate", otherId: "kofi-2", otherName: "Kofi Ansa", via: "phone" }],
      }),
      reply({
        id: "kofi-2",
        fullName: "Kofi Ansa",
        phone: "+233 55 111 2222",
        otherNames: "Esi Ansa",
        flags: [{ kind: "possible-duplicate", otherId: "kofi", otherName: "Kofi Ansah", via: "phone" }],
      }),
    ],
    new Map(),
    celebrations,
    now,
  );

  it("counts each filter", () => {
    expect(countByFilter(rows)).toEqual({ all: 3, coming: 2, notComing: 1, thanksgiving: 1, toCheck: 2, emailFailed: 1 });
  });

  it("filters by coming, can't come, to check and failed email", () => {
    const ids = (filter: Parameters<typeof matchesFilter>[1]) =>
      rows.filter((row) => matchesFilter(row, filter)).map((row) => row.id);
    expect(ids("coming")).toEqual(["ama", "kofi-2"]);
    expect(ids("notComing")).toEqual(["kofi"]);
    expect(ids("toCheck")).toEqual(["kofi", "kofi-2"]);
    expect(ids("emailFailed")).toEqual(["ama"]);
  });

  it("counts only Saturday's answers for Coming and Can't come", () => {
    const [thanksgivingOnly, receptionOnly] = toReplyRows(
      [
        reply({ id: "efua", fullName: "Efua Mensah", answers: { ceremony: "no", reception: "no", thanks: "yes" } }),
        reply({ id: "yaw", fullName: "Yaw Boateng", answers: { reception: "yes", thanks: "no" } }),
      ],
      new Map(),
      celebrations,
      now,
    );
    expect(matchesFilter(thanksgivingOnly, "notComing")).toBe(true);
    expect(matchesFilter(thanksgivingOnly, "coming")).toBe(false);
    expect(matchesFilter(receptionOnly, "coming")).toBe(true);
  });

  it("lists a guest who said yes to the thanksgiving, even after replying again without it", () => {
    const current = reply({ id: "ama", fullName: "Ama Owusu", answers: { ceremony: "yes" } });
    const earlier = reply({
      id: "ama-before",
      fullName: "Ama Owusu",
      answers: { ceremony: "yes", thanks: "yes" },
      receivedAt: "2026-10-28T18:02:00Z",
      supersededAt: "2026-10-29T09:41:00Z",
    });
    const saidYesNow = reply({ id: "efua", fullName: "Efua Mensah", answers: { ceremony: "no", thanks: "yes" } });
    const neverSaidYes = reply({ id: "kwame", fullName: "Kwame Owusu" });
    const [ama, efua, kwame] = toReplyRows([current, saidYesNow, neverSaidYes], new Map([["ama", [earlier]]]), celebrations, now);
    expect(ama.saidYesToThanksgiving).toBe(true);
    expect(matchesFilter(ama, "thanksgiving")).toBe(true);
    expect(matchesFilter(efua, "thanksgiving")).toBe(true);
    expect(kwame.saidYesToThanksgiving).toBe(false);
    expect(matchesFilter(kwame, "thanksgiving")).toBe(false);
  });

  it("counts the replies on the thanksgiving's card from its filter, earlier replies included", () => {
    const earlier = reply({ id: "ama-before", fullName: "Ama Owusu", answers: { thanks: "yes" }, supersededAt: "2026-10-29T09:41:00Z" });
    const rows = toReplyRows(
      [
        reply({ id: "ama", fullName: "Ama Owusu", answers: { ceremony: "yes" } }),
        reply({ id: "efua", fullName: "Efua Mensah", answers: { reception: "no", thanks: "yes" } }),
        reply({ id: "kwame", fullName: "Kwame Owusu" }),
      ],
      new Map([["ama", [earlier]]]),
      celebrations,
      now,
    );
    expect(countByFilter(rows).thanksgiving).toBe(2);
    expect(countByFilter(rows).thanksgiving).toBe(rows.filter((row) => matchesFilter(row, "thanksgiving")).length);
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

describe("searching by phone", () => {
  const rows = toReplyRows(
    [
      reply({ id: "local", fullName: "Ama Owusu", phone: "024 000 0000" }),
      reply({ id: "international", fullName: "Kofi Ansah", phone: "+233 55 111 2222" }),
      reply({ id: "with-local-zero", fullName: "Esi Ansa", phone: "00233 (0)20 333 4444" }),
      reply({ id: "abroad", fullName: "Yaw Boateng", phone: "+44 7700 900123" }),
    ],
    new Map(),
    celebrations,
    now,
  );
  const found = (query: string) => rows.filter((row) => matchesSearch(row, query)).map((row) => row.id);

  it("finds a Ghana number however either side writes it", () => {
    for (const query of ["024 000 0000", "0240000000", "+233 24 000 0000", "+233 (0)24 000 0000", "00233 24 000 0000", "00233 (0)24 000 0000", "+2330240000000"]) {
      expect(found(query), query).toEqual(["local"]);
    }
    for (const query of ["055 111 2222", "+233 (0)55 111 2222", "00233 55 111 2222"]) {
      expect(found(query), query).toEqual(["international"]);
    }
    for (const query of ["020 333 4444", "+233 20 333 4444", "00233 20 333 4444"]) {
      expect(found(query), query).toEqual(["with-local-zero"]);
    }
  });

  it("finds a number from abroad with + or 00", () => {
    expect(found("+44 7700 900123")).toEqual(["abroad"]);
    expect(found("0044 7700 900123")).toEqual(["abroad"]);
  });

  it("finds a number from its first digits, typed in any of those ways", () => {
    expect(found("0240")).toEqual(["local"]);
    expect(found("024 0")).toEqual(["local"]);
    for (const query of ["+233 24", "+233 (0)24", "00233 24", "00233 (0)24", "233 24"]) {
      expect(found(query), query).toEqual(["local"]);
    }
    expect(found("+233 (0)55 1")).toEqual(["international"]);
    expect(found("+44 77")).toEqual(["abroad"]);
  });

  it("finds a number from digits in its middle", () => {
    expect(found("111 22")).toEqual(["international"]);
    expect(found("3334")).toEqual(["with-local-zero"]);
  });

  it("reads \"00\" alone as no number yet: it finds the replies that show 00, not every reply", () => {
    expect(found("00")).toEqual(["local", "with-local-zero", "abroad"]);
  });
});

describe("replyColumns", () => {
  it("puts the thanksgiving last among the columns, as no longer asked", () => {
    expect(replyColumns(contentDefaults.celebrations)).toEqual([
      { id: "ceremony", name: "White wedding" },
      { id: "reception", name: "Reception" },
      { id: "thanks", name: "Thanksgiving (no longer asked)" },
    ]);
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
        flags: [
          { kind: "replied-again", otherId: "ama-before", otherName: "AMA owusu", via: "phone" },
          { kind: "possible-duplicate", otherId: "kwame", otherName: "Kwame Owusu", via: "email" },
        ],
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
      "Thanksgiving (no longer asked)",
      "Other names",
      "Song",
      "Received",
      "Email status",
      "Flags",
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
      "Replied again: AMA owusu (same phone); Possible duplicate of Kwame Owusu (same email)",
    ]);
    expect(rows[2][10]).toBe("No email");
    expect(rows[2][11]).toBe("");
    expect(rows).toHaveLength(3);
  });

  it("says Not sent for a reply with an email and no confirmation queued", () => {
    const rows = replyCsvRows([reply({ id: "efua", fullName: "Efua Mensah", email: "efua@example.com" })], celebrations);
    expect(rows[1][10]).toBe("Not sent");
  });
});

describe("emailStatusLabel", () => {
  it("tells a reply without an email from one whose confirmation was never queued", () => {
    expect(emailStatusLabel({ emailStatus: "none" })).toBe("No email");
    expect(emailStatusLabel({ email: "efua@example.com", emailStatus: "none" })).toBe("Not sent");
    expect(emailStatusLabel({ email: "efua@example.com", emailStatus: "queued" })).toBe("Sending");
    expect(emailStatusLabel({ email: "efua@example.com", emailStatus: "sent" })).toBe("Sent");
    expect(emailStatusLabel({ email: "efua@example.com", emailStatus: "failed" })).toBe("Failed");
  });
});
