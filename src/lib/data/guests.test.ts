import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDb } from "../../../test/db";
import { createGuest, findGuestById, findGuestByToken, setGuestName } from "./guests";

beforeEach(resetDb);

// 32 random bytes in base64url, without padding: 43 letters, digits, - and _.
const URL_SAFE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

describe("createGuest", () => {
  it("keeps the name the guest gave, trimmed", async () => {
    const guest = await createGuest("  Ama Owusu ");
    expect(guest.displayName).toBe("Ama Owusu");
    expect(guest.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(guest.createdAt))).toBe(false);
  });

  it("cuts a name to 80 characters, as it shows on every album tile and in emails", async () => {
    const guest = await createGuest("A".repeat(200));
    expect(guest.displayName).toBe("A".repeat(80));
  });

  it("keeps no name when the guest gave none", async () => {
    expect((await createGuest(null)).displayName).toBeNull();
    expect((await createGuest("   ")).displayName).toBeNull();
  });

  it("gives every guest their own URL-safe link token", async () => {
    const guests = await Promise.all(Array.from({ length: 50 }, () => createGuest("Kofi")));
    const tokens = guests.map((guest) => guest.linkToken);
    for (const token of tokens) {
      expect(token).toMatch(URL_SAFE_TOKEN);
      expect(encodeURIComponent(token)).toBe(token);
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("findGuestByToken", () => {
  it("finds the guest a personal link belongs to", async () => {
    const guest = await createGuest("Esi");
    expect(await findGuestByToken(guest.linkToken)).toEqual(guest);
  });

  it("finds no one for an unknown token", async () => {
    await createGuest("Esi");
    expect(await findGuestByToken(randomBytes(32).toString("base64url"))).toBeNull();
  });

  it("finds no one for a token that isn't shaped like one", async () => {
    expect(await findGuestByToken("")).toBeNull();
    expect(await findGuestByToken("not a token")).toBeNull();
    expect(await findGuestByToken("a".repeat(10_000))).toBeNull();
  });
});

describe("findGuestById", () => {
  it("finds the guest with that id", async () => {
    const guest = await createGuest("Abena");
    expect(await findGuestById(guest.id)).toEqual(guest);
  });

  it("finds no one for an unknown id, or an id that isn't one", async () => {
    await createGuest("Abena");
    expect(await findGuestById(randomUUID())).toBeNull();
    expect(await findGuestById("guest-1")).toBeNull();
    expect(await findGuestById("")).toBeNull();
  });
});

describe("setGuestName", () => {
  it("changes the guest's name and returns them", async () => {
    const guest = await createGuest("Yaw");
    const renamed = await setGuestName(guest.id, " Yaw Mensah ");
    expect(renamed).toEqual({ ...guest, displayName: "Yaw Mensah" });
    expect(await findGuestByToken(guest.linkToken)).toEqual(renamed);
  });

  it("cuts a new name to 80 characters too", async () => {
    const guest = await createGuest("Yaw");
    expect((await setGuestName(guest.id, "Ɔ".repeat(200)))?.displayName).toBe("Ɔ".repeat(80));
  });

  it("clears the name when given none", async () => {
    const guest = await createGuest("Yaw");
    expect((await setGuestName(guest.id, ""))?.displayName).toBeNull();
  });

  it("returns null for a guest that doesn't exist, or an id that isn't one", async () => {
    expect(await setGuestName(randomUUID(), "Yaw")).toBeNull();
    expect(await setGuestName("guest-1", "Yaw")).toBeNull();
  });
});
