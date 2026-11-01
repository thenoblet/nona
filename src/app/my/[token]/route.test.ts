import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest, findGuestById } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { guests } from "@/lib/db/schema";
import { resetDb } from "../../../../test/db";
import { browserCookies } from "../../../../test/next-cookies";

vi.mock("next/headers", () => import("../../../../test/next-cookies"));
vi.mock("next/server", () => ({ connection: async () => {} }));

const database = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/data/guests", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/data/guests")>();
  return {
    ...real,
    findGuestByToken: (token: string) => {
      if (database.down) return Promise.reject(Object.assign(new Error(`select failed for ${token}`), { code: "57014" }));
      return real.findGuestByToken(token);
    },
  };
});

import { guestCookieName, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { GET, POST } from "./route";

const SITE = "https://example.com";
const SAME_ORIGIN = { Origin: SITE, "Sec-Fetch-Site": "same-origin" };

function open(token: string) {
  return GET(new Request(`${SITE}/my/${encodeURIComponent(token)}`), { params: Promise.resolve({ token }) });
}

/** Submits the confirm page's form: `choice` is "yes" or "no". */
function choose(token: string, choice: string, headers: Record<string, string> = SAME_ORIGIN) {
  return POST(
    new Request(`${SITE}/my/${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams({ choice }).toString(),
    }),
    { params: Promise.resolve({ token }) },
  );
}

function unknownToken(): string {
  return randomBytes(32).toString("base64url");
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
  database.down = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /my/[token]", () => {
  it("asks a browser without a guest to confirm, setting no cookie", async () => {
    const guest = await createGuest("Ama");
    const response = await open(guest.linkToken);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`/my/${guest.linkToken}/confirm`);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(browserCookies.sets).toHaveLength(0);
    expect(await readGuestIds()).toEqual([]);
  });

  it("asks a browser with its own, different guest to confirm too, changing nothing: opening a link never adopts (Ruling CG)", async () => {
    const [own, remembered, linked] = [await createGuest("Kofi"), await createGuest("Yaw"), await createGuest("Ama")];
    for (const ids of [[own.id], [own.id, linked.id, remembered.id]]) {
      sendCookie(ids);
      const response = await open(linked.linkToken);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(`/my/${linked.linkToken}/confirm`);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(browserCookies.sets).toHaveLength(0);
      expect(await readGuestIds()).toEqual(ids);
    }
  });

  it("opens the uploads of a browser whose own guest is the linked one, changing nothing", async () => {
    const [linked, remembered] = [await createGuest("Ama"), await createGuest("Yaw")];
    sendCookie([linked.id, remembered.id]);
    const response = await open(linked.linkToken);
    expect(response.headers.get("Location")).toBe("/album?view=mine");
    expect(browserCookies.sets).toHaveLength(0);
    expect(await readGuestIds()).toEqual([linked.id, remembered.id]);
  });

  it("asks to confirm when the browser's cookie is forged, as if it had none", async () => {
    const linked = await createGuest("Ama");
    browserCookies.values.set(guestCookieName(), `${linked.id}.forged`);
    expect((await open(linked.linkToken)).headers.get("Location")).toBe(`/my/${linked.linkToken}/confirm`);
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("opens the album and changes nothing for an unknown or malformed token", async () => {
    const own = await createGuest("Kofi");
    sendCookie([own.id]);
    const cookie = browserCookies.values.get(guestCookieName());

    for (const token of [unknownToken(), "not-a-token", "", "a".repeat(10_000), `${own.linkToken}x`, "../album"]) {
      const response = await open(token);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/album");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(browserCookies.sets).toHaveLength(0);
    expect(browserCookies.values.get(guestCookieName())).toBe(cookie);
  });

  it("opens the album for an unknown token in a browser without a guest, setting no cookie", async () => {
    const response = await open(unknownToken());
    expect(response.headers.get("Location")).toBe("/album");
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("limits a browser with a cookie to 20 quick opens, then answers 429 with Retry-After and remembers nothing", async () => {
    // Hold the limiter's clock still, so a slow machine can't refill a token mid-test.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    sendCookie([own.id]);
    for (let opened = 0; opened < 20; opened += 1) expect((await open(unknownToken())).status).toBe(302);

    const refused = await open(linked.linkToken);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("1");
    expect(refused.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await readGuestIds()).toEqual([own.id]);
  });

  it("never limits a browser without a cookie: there is nothing to key on, and the token is the secret", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    for (let opened = 0; opened < 40; opened += 1) expect((await open(unknownToken())).status).toBe(302);
  });

  it("answers 503 when the database fails, logging neither the token nor the error's message", async () => {
    const guest = await createGuest("Ama");
    database.down = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await open(guest.linkToken);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(browserCookies.sets).toHaveLength(0);
    const output = logged.mock.calls.flat().join(" ");
    expect(output).toContain("57014");
    expect(output).not.toContain(guest.linkToken);
  });
});

describe("POST /my/[token], from the confirm page", () => {
  it('"Yes, that\'s me" makes the linked guest this browser\'s own and opens its uploads', async () => {
    const linked = await createGuest("Ama");
    const response = await choose(linked.linkToken, "yes");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/album?view=mine");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await readGuestIds()).toEqual([linked.id]);
    expect(await guestCount()).toBe(1);
  });

  it('"No, I\'m someone else" makes a new own guest and remembers the linked one after it', async () => {
    const linked = await createGuest("Ama");
    const response = await choose(linked.linkToken, "no");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/album?view=mine");
    const [ownId, ...remembered] = await readGuestIds();
    expect(ownId).not.toBe(linked.id);
    expect(remembered).toEqual([linked.id]);
    expect((await findGuestById(ownId))?.displayName).toBeNull();
    expect((await findGuestById(linked.id))?.displayName).toBe("Ama");
    expect(await guestCount()).toBe(2);
  });

  it('"Yes, that\'s me" on a browser that already shared makes the linked guest its own from now on, its earlier guest remembered first (Ruling CG)', async () => {
    const [own, remembered, linked] = [await createGuest("Kofi"), await createGuest("Yaw"), await createGuest("Ama")];
    sendCookie([own.id, remembered.id]);
    const response = await choose(linked.linkToken, "yes");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/album?view=mine");
    expect(await readGuestIds()).toEqual([linked.id, own.id, remembered.id]);
    // Nobody's uploads move and no guest is merged or made.
    expect(await guestCount()).toBe(3);
    expect((await findGuestById(own.id))?.displayName).toBe("Kofi");
  });

  it('"Yes, that\'s me" on a browser whose own guest is the linked one changes nothing', async () => {
    const [linked, remembered] = [await createGuest("Ama"), await createGuest("Yaw")];
    sendCookie([linked.id, remembered.id]);
    expect((await choose(linked.linkToken, "yes")).status).toBe(303);
    expect(await readGuestIds()).toEqual([linked.id, remembered.id]);
  });

  it('"No, I\'m someone else" on a browser with its own guest keeps it first and remembers the linked one beside it', async () => {
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    sendCookie([own.id]);
    expect((await choose(linked.linkToken, "no")).status).toBe(303);
    expect(await readGuestIds()).toEqual([own.id, linked.id]);
    expect(await guestCount()).toBe(2);
  });

  it("accepts the site's own host behind the proxy (X-Forwarded-Host) and a browser that sends only Origin", async () => {
    const linked = await createGuest("Ama");
    const forwarded = await POST(
      new Request(`http://localhost:3000/my/${linked.linkToken}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Forwarded-Host": "example.com",
          ...SAME_ORIGIN,
        },
        body: "choice=yes",
      }),
      { params: Promise.resolve({ token: linked.linkToken }) },
    );
    expect(forwarded.status).toBe(303);

    browserCookies.clear();
    expect((await choose(linked.linkToken, "yes", { Origin: SITE })).status).toBe(303);
  });

  it("refuses with 403 anything not posted from the site's own page, changing nothing", async () => {
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    sendCookie([own.id]);
    const cookie = browserCookies.values.get(guestCookieName());
    const crossSite: Record<string, string>[] = [
      {},
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { Origin: "not a url" },
      { Origin: "https://example.com.attacker.example", "Sec-Fetch-Site": "cross-site" },
      { Origin: "https://media.example.com", "Sec-Fetch-Site": "same-site" },
      { Origin: SITE, "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of crossSite) {
      for (const choice of ["yes", "no"]) {
        const response = await choose(linked.linkToken, choice, headers);
        expect(response.status, JSON.stringify(headers)).toBe(403);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      }
    }
    expect(browserCookies.sets).toHaveLength(0);
    expect(browserCookies.values.get(guestCookieName())).toBe(cookie);
    expect(await guestCount()).toBe(2);

    browserCookies.clear();
    expect((await choose(linked.linkToken, "yes", { Origin: "https://attacker.example" })).status).toBe(403);
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("opens the album and changes nothing for an unknown token", async () => {
    for (const choice of ["yes", "no"]) {
      const response = await choose(unknownToken(), choice);
      expect(response.status).toBe(303);
      expect(response.headers.get("Location")).toBe("/album");
    }
    expect(browserCookies.sets).toHaveLength(0);
    expect(await guestCount()).toBe(0);
  });

  it("refuses a choice it doesn't know with 400, and a body over 1 KB with 413, changing nothing", async () => {
    const linked = await createGuest("Ama");
    for (const choice of ["", "maybe", "YES"]) expect((await choose(linked.linkToken, choice)).status).toBe(400);
    expect((await choose(linked.linkToken, `yes${"x".repeat(2_000)}`)).status).toBe(413);
    expect(browserCookies.sets).toHaveLength(0);
    expect(await guestCount()).toBe(1);
  });

  it("is limited in the link bucket once the browser has a guest", async () => {
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    sendCookie([own.id]);
    for (let opened = 0; opened < 20; opened += 1) expect((await open(unknownToken())).status).toBe(302);
    const refused = await choose(linked.linkToken, "yes");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("1");
    expect(await readGuestIds()).toEqual([own.id]);
  });

  it("answers 503 when the database fails, changing nothing and logging no token", async () => {
    const linked = await createGuest("Ama");
    database.down = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await choose(linked.linkToken, "no");
    expect(response.status).toBe(503);
    expect(browserCookies.sets).toHaveLength(0);
    expect(await guestCount()).toBe(1);
    expect(logged.mock.calls.flat().join(" ")).not.toContain(linked.linkToken);
  });
});
