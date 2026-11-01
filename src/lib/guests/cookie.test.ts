import { createHmac, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest, findGuestById } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { guests } from "@/lib/db/schema";
import { guestCookieSecret } from "@/lib/env";
import { resetDb } from "../../../test/db";
import { browserCookies } from "../../../test/next-cookies";

vi.mock("next/headers", () => import("../../../test/next-cookies"));

import {
  adoptGuest,
  ensureOwnGuest,
  guestCookieName,
  ownGuestId,
  personalLink,
  readGuestIds,
  rememberGuest,
  renameOwnGuest,
  signGuestIds,
  verifyGuestIds,
} from "./cookie";

const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;
const COOKIE_SHAPE = /^[0-9a-f-]{36}(,[0-9a-f-]{36}){0,9}\.[A-Za-z0-9_-]{43}$/;

/** Signs any text with the secret the tests run with, as only the server could. */
function signedByServer(ids: string): string {
  return `${ids}.${createHmac("sha256", guestCookieSecret()).update(ids).digest("base64url")}`;
}

function sendCookie(ids: string[]) {
  browserCookies.values.set(guestCookieName(), signGuestIds(ids));
}

async function guestCount(): Promise<number> {
  return (await getDb().select().from(guests)).length;
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signing", () => {
  it("round-trips the ids, the browser's own first", () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const value = signGuestIds(ids);
    expect(value).toMatch(COOKIE_SHAPE);
    expect(verifyGuestIds(value)).toEqual(ids);
  });

  it("reads a tampered cookie as no ids", () => {
    const [own, other] = [randomUUID(), randomUUID()];
    const value = signGuestIds([own, other]);
    const [ids, signature] = value.split(".");
    const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;

    expect(verifyGuestIds(`${other},${own}.${signature}`)).toEqual([]);
    expect(verifyGuestIds(`${ids},${randomUUID()}.${signature}`)).toEqual([]);
    expect(verifyGuestIds(`${randomUUID()}.${signature}`)).toEqual([]);
    expect(verifyGuestIds(`${ids}.${flipped}`)).toEqual([]);
    expect(verifyGuestIds(`${ids}.${signature}A`)).toEqual([]);
    expect(verifyGuestIds(`${ids}.${signature.slice(0, -1)}`)).toEqual([]);
    expect(verifyGuestIds(`${ids}.`)).toEqual([]);
    expect(verifyGuestIds(ids)).toEqual([]);
    expect(verifyGuestIds("")).toEqual([]);
    expect(verifyGuestIds(undefined)).toEqual([]);
    expect(verifyGuestIds("not a cookie")).toEqual([]);
    expect(verifyGuestIds(".".repeat(5_000))).toEqual([]);
  });

  it("reads a cookie signed with another secret as no ids", () => {
    vi.stubEnv("GUEST_COOKIE_SECRET", "another-secret-of-at-least-32-bytes!");
    const value = signGuestIds([randomUUID()]);
    vi.unstubAllEnvs();
    expect(verifyGuestIds(value)).toEqual([]);
  });

  it("reads as no ids anything it would never have signed: no ids, ids that aren't uuids, more than ten", () => {
    expect(verifyGuestIds(signedByServer(""))).toEqual([]);
    expect(verifyGuestIds(signedByServer("guest-1"))).toEqual([]);
    expect(verifyGuestIds(signedByServer(`${randomUUID()},,${randomUUID()}`))).toEqual([]);
    const eleven = Array.from({ length: 11 }, () => randomUUID());
    expect(verifyGuestIds(signedByServer(eleven.join(",")))).toEqual([]);
    expect(verifyGuestIds(signedByServer(eleven.slice(0, 10).join(",")))).toEqual(eleven.slice(0, 10));
  });
});

describe("readGuestIds and ownGuestId", () => {
  it("know no one when the browser sent no cookie", async () => {
    expect(await readGuestIds()).toEqual([]);
    expect(await ownGuestId()).toBeNull();
  });

  it("read the ids the browser carries, its own first", async () => {
    const ids = [randomUUID(), randomUUID()];
    sendCookie(ids);
    expect(await readGuestIds()).toEqual(ids);
    expect(await ownGuestId()).toBe(ids[0]);
  });

  it("know no one when the cookie was tampered with", async () => {
    const value = signGuestIds([randomUUID()]);
    browserCookies.values.set(guestCookieName(), `${randomUUID()}${value.slice(36)}`);
    expect(await readGuestIds()).toEqual([]);
    expect(await ownGuestId()).toBeNull();
  });

  it("refuse clearly in production when the secret is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_COOKIE_SECRET", "");
    await expect(readGuestIds()).rejects.toThrow("Missing guest cookie setting: GUEST_COOKIE_SECRET");
  });
});

describe("the cookie", () => {
  it("is nona_guest outside production: httpOnly, SameSite=Lax, for the whole site, for two years, not Secure", async () => {
    expect(guestCookieName()).toBe("nona_guest");
    await ensureOwnGuest("Ama");
    expect(browserCookies.sets).toHaveLength(1);
    const [cookie] = browserCookies.sets;
    expect(cookie.name).toBe("nona_guest");
    expect(cookie.value).toMatch(COOKIE_SHAPE);
    expect(cookie.options).toEqual({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: TWO_YEARS_SECONDS });
  });

  it("is __Host-nona_guest in production: Secure, Path=/ and no Domain, so no subdomain can set or read it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_COOKIE_SECRET", "a-production-secret-of-32-bytes-or-more");
    expect(guestCookieName()).toBe("__Host-nona_guest");
    await ensureOwnGuest("Ama");
    const [cookie] = browserCookies.sets;
    expect(cookie.name).toBe("__Host-nona_guest");
    expect(cookie.options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: TWO_YEARS_SECONDS });
  });

  it("is read by the same name it is written by, and the other environment's name is ignored", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("GUEST_COOKIE_SECRET", "a-production-secret-of-32-bytes-or-more");
    const ids = [randomUUID()];
    browserCookies.values.set("nona_guest", signGuestIds(ids));
    expect(await readGuestIds()).toEqual([]);
    browserCookies.values.set("__Host-nona_guest", signGuestIds(ids));
    expect(await readGuestIds()).toEqual(ids);
  });
});

describe("rememberGuest", () => {
  it("makes the linked guest the browser's own when it has none", async () => {
    const linked = randomUUID();
    await rememberGuest(linked);
    expect(await readGuestIds()).toEqual([linked]);
  });

  it("keeps the browser's own id first, puts the newest next and drops duplicates", async () => {
    const [own, first, second] = [randomUUID(), randomUUID(), randomUUID()];
    sendCookie([own]);

    await rememberGuest(first);
    expect(await readGuestIds()).toEqual([own, first]);
    await rememberGuest(second);
    expect(await readGuestIds()).toEqual([own, second, first]);
    await rememberGuest(first);
    expect(await readGuestIds()).toEqual([own, first, second]);
    await rememberGuest(own);
    expect(await readGuestIds()).toEqual([own, first, second]);
  });

  it("never replaces the browser's own id, and keeps at most ten, dropping the oldest remembered", async () => {
    const own = randomUUID();
    sendCookie([own]);
    const remembered = Array.from({ length: 12 }, () => randomUUID());
    for (const guestId of remembered) await rememberGuest(guestId);

    const ids = await readGuestIds();
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe(own);
    expect(ids.slice(1)).toEqual(remembered.slice(-9).reverse());
  });

  it("refuses something that isn't a guest id, leaving the cookie alone", async () => {
    const own = randomUUID();
    sendCookie([own]);
    await expect(rememberGuest("guest-1")).rejects.toThrow();
    await expect(rememberGuest(`${randomUUID()},${randomUUID()}`)).rejects.toThrow();
    expect(browserCookies.sets).toHaveLength(0);
    expect(await readGuestIds()).toEqual([own]);
  });
});

describe("adoptGuest (Ruling CG)", () => {
  it("makes the linked guest the browser's own when it has none", async () => {
    const linked = randomUUID();
    expect(await adoptGuest(linked)).toEqual([linked]);
    expect(await readGuestIds()).toEqual([linked]);
  });

  it("makes the linked guest the browser's own over another, which becomes the first remembered", async () => {
    const [own, remembered, linked] = [randomUUID(), randomUUID(), randomUUID()];
    sendCookie([own, remembered]);
    await adoptGuest(linked);
    expect(await readGuestIds()).toEqual([linked, own, remembered]);
  });

  it("moves a linked guest the browser already remembered to its own, with no repeats", async () => {
    const [own, first, linked] = [randomUUID(), randomUUID(), randomUUID()];
    sendCookie([own, linked, first]);
    await adoptGuest(linked);
    expect(await readGuestIds()).toEqual([linked, own, first]);
  });

  it("changes nothing when the linked guest is already the browser's own", async () => {
    const [own, remembered] = [randomUUID(), randomUUID()];
    sendCookie([own, remembered]);
    await adoptGuest(own);
    expect(await readGuestIds()).toEqual([own, remembered]);
  });

  it("keeps at most ten, dropping the oldest remembered", async () => {
    const ids = Array.from({ length: 10 }, () => randomUUID());
    sendCookie(ids);
    const linked = randomUUID();
    await adoptGuest(linked);
    expect(await readGuestIds()).toEqual([linked, ...ids.slice(0, 9)]);
  });

  it("refuses something that isn't a guest id, leaving the cookie alone", async () => {
    const own = randomUUID();
    sendCookie([own]);
    await expect(adoptGuest("guest-1")).rejects.toThrow();
    expect(browserCookies.sets).toHaveLength(0);
    expect(await readGuestIds()).toEqual([own]);
  });
});

describe("ensureOwnGuest", () => {
  it("makes the browser's own guest with the name given and sets the cookie", async () => {
    const guest = await ensureOwnGuest("  Kofi Boateng ");
    expect(guest.displayName).toBe("Kofi Boateng");
    expect(await findGuestById(guest.id)).toEqual(guest);
    expect(await readGuestIds()).toEqual([guest.id]);
  });

  it("makes a guest without a name when none is given", async () => {
    expect((await ensureOwnGuest()).displayName).toBeNull();
    browserCookies.clear();
    expect((await ensureOwnGuest(null)).displayName).toBeNull();
  });

  it("reuses the browser's own guest, creating none and leaving the cookie as it is", async () => {
    const first = await ensureOwnGuest("Kofi");
    const setsBefore = browserCookies.sets.length;
    const again = await ensureOwnGuest();
    expect(again).toEqual(first);
    expect(await guestCount()).toBe(1);
    expect(browserCookies.sets).toHaveLength(setsBefore);
  });

  it("never renames the browser's own guest, nor clears its name with a blank: only Change does (Ruling CG)", async () => {
    const guest = await ensureOwnGuest("Kofi");
    for (const name of [" Kofi Boateng ", "Ama Owusu", "", "   ", null]) {
      expect((await ensureOwnGuest(name)).displayName).toBe("Kofi");
    }
    expect((await findGuestById(guest.id))?.displayName).toBe("Kofi");
  });

  it("names the browser's own guest when it has no name, as a phone's first upload does", async () => {
    const own = await createGuest(null);
    sendCookie([own.id]);
    expect((await ensureOwnGuest(" Kofi Boateng ")).displayName).toBe("Kofi Boateng");
    expect((await findGuestById(own.id))?.displayName).toBe("Kofi Boateng");
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("keeps a linked guest's own name after a phone takes it over, whatever name that phone typed (Ruling CG)", async () => {
    const earlier = await ensureOwnGuest("Kofi");
    const linked = await createGuest("Ama Owusu");
    await adoptGuest(linked.id);
    expect(await ensureOwnGuest("Kofi")).toEqual(linked);
    expect((await findGuestById(linked.id))?.displayName).toBe("Ama Owusu");
    expect((await findGuestById(earlier.id))?.displayName).toBe("Kofi");
  });

  it("Ruling D: after one awaited call, three parallel calls with that cookie reuse the guest and create none", async () => {
    const first = await ensureOwnGuest("Esi");
    const parallel = await Promise.all([ensureOwnGuest("Esi"), ensureOwnGuest("Esi"), ensureOwnGuest("Esi")]);
    expect(parallel.map((guest) => guest.id)).toEqual([first.id, first.id, first.id]);
    expect(await guestCount()).toBe(1);
    expect(await ownGuestId()).toBe(first.id);
  });

  it("without that first awaited call, three parallel calls make three guests: why the client awaits one", async () => {
    const parallel = await Promise.all([ensureOwnGuest("Esi"), ensureOwnGuest("Esi"), ensureOwnGuest("Esi")]);
    expect(new Set(parallel.map((guest) => guest.id)).size).toBe(3);
    expect(await guestCount()).toBe(3);
  });

  it("starts a new own guest when the cookie names one the database no longer has, keeping the remembered ones", async () => {
    const remembered = await createGuest("Yaw");
    const vanished = randomUUID();
    sendCookie([vanished, remembered.id]);

    const guest = await ensureOwnGuest("Akosua");
    expect(guest.id).not.toBe(vanished);
    expect(guest.displayName).toBe("Akosua");
    expect(await readGuestIds()).toEqual([guest.id, remembered.id]);
  });

  it("treats a tampered cookie as none", async () => {
    const existing = await createGuest("Yaw");
    browserCookies.values.set(guestCookieName(), `${existing.id}.forged`);
    const guest = await ensureOwnGuest("Akosua");
    expect(guest.id).not.toBe(existing.id);
    expect(await readGuestIds()).toEqual([guest.id]);
  });

  it("reuses a guest opened through a personal link when it became the browser's own", async () => {
    const linked = await createGuest("Adwoa");
    await rememberGuest(linked.id);
    expect((await ensureOwnGuest()).id).toBe(linked.id);
    expect(await guestCount()).toBe(1);
  });
});

describe("renameOwnGuest (Change)", () => {
  it("renames the browser's own guest, trimmed, and leaves the cookie", async () => {
    const own = await createGuest("Kofi");
    sendCookie([own.id]);
    expect((await renameOwnGuest(" Kofi Boateng "))?.displayName).toBe("Kofi Boateng");
    expect((await findGuestById(own.id))?.displayName).toBe("Kofi Boateng");
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("leaves the name for a blank one", async () => {
    const own = await createGuest("Kofi");
    sendCookie([own.id]);
    expect((await renameOwnGuest("   "))?.displayName).toBe("Kofi");
  });

  it("makes no guest and sets no cookie for a browser without one", async () => {
    expect(await renameOwnGuest("Kofi")).toBeNull();
    expect(await guestCount()).toBe(0);
    expect(browserCookies.sets).toHaveLength(0);
  });
});

describe("personalLink", () => {
  it("is the site's address with /my/ and the guest's token", async () => {
    vi.stubEnv("SITE_URL", "https://wedding.example.com/");
    const guest = await createGuest("Ama");
    expect(await personalLink(guest.id)).toBe(`https://wedding.example.com/my/${guest.linkToken}`);
  });

  it("is null for a guest that doesn't exist", async () => {
    expect(await personalLink(randomUUID())).toBeNull();
    expect(await personalLink("guest-1")).toBeNull();
  });
});
