import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
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

import { GUEST_COOKIE, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

function open(token: string) {
  return GET(new Request(`https://example.com/my/${encodeURIComponent(token)}`), {
    params: Promise.resolve({ token }),
  });
}

function unknownToken(): string {
  return randomBytes(32).toString("base64url");
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
  it("remembers the guest the link belongs to and opens their uploads, uncached", async () => {
    const guest = await createGuest("Ama");
    const response = await open(guest.linkToken);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/album?view=mine");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await readGuestIds()).toEqual([guest.id]);
  });

  it("adds the linked guest after the browser's own, which stays first", async () => {
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    browserCookies.values.set(GUEST_COOKIE, signGuestIds([own.id]));
    expect((await open(linked.linkToken)).headers.get("Location")).toBe("/album?view=mine");
    expect(await readGuestIds()).toEqual([own.id, linked.id]);
  });

  it("opens the album and changes nothing for an unknown or malformed token", async () => {
    const own = await createGuest("Kofi");
    const cookie = signGuestIds([own.id]);
    browserCookies.values.set(GUEST_COOKIE, cookie);

    for (const token of [unknownToken(), "not-a-token", "", "a".repeat(10_000), `${own.linkToken}x`, "../album"]) {
      const response = await open(token);
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/album");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(browserCookies.sets).toHaveLength(0);
    expect(browserCookies.values.get(GUEST_COOKIE)).toBe(cookie);
  });

  it("sets no cookie for an unknown token in a browser that has none", async () => {
    await open(unknownToken());
    expect(browserCookies.sets).toHaveLength(0);
    expect(await readGuestIds()).toEqual([]);
  });

  it("limits a browser with a cookie to 20 quick opens, then answers 429 with Retry-After and remembers nothing", async () => {
    // Hold the limiter's clock still, so a slow machine can't refill a token mid-test.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const [own, linked] = [await createGuest("Kofi"), await createGuest("Ama")];
    browserCookies.values.set(GUEST_COOKIE, signGuestIds([own.id]));
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
