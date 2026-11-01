import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findGuestById } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { guests } from "@/lib/db/schema";
import { siteUrl } from "@/lib/site-url";
import { resetDb } from "../../../../test/db";
import { browserCookies } from "../../../../test/next-cookies";

vi.mock("next/headers", () => import("../../../../test/next-cookies"));

const database = vi.hoisted(() => ({ down: false }));
vi.mock("@/lib/data/guests", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/data/guests")>();
  return {
    ...real,
    createGuest: (displayName: string | null) => {
      if (database.down) return Promise.reject(Object.assign(new Error(`insert failed for ${displayName}`), { code: "57014" }));
      return real.createGuest(displayName);
    },
  };
});

import { guestCookieName, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { PATCH, POST } from "./route";

const URL_BASE = "https://example.com/api/guest";

function post(body: unknown = {}) {
  return POST(
    new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  );
}

function patch(body: unknown, contentType = "application/json") {
  return PATCH(new Request(URL_BASE, { method: "PATCH", headers: { "Content-Type": contentType }, body: JSON.stringify(body) }));
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

describe("POST /api/guest", () => {
  it("makes the browser's own guest with the name given, sets the cookie and returns the id, uncached", async () => {
    const response = await post({ displayName: " Ama Owusu " });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { guestId } = await response.json();
    expect((await findGuestById(guestId))?.displayName).toBe("Ama Owusu");
    expect(await readGuestIds()).toEqual([guestId]);
  });

  it("returns the guest's personal link with it, for the uploader's offer, with no second lookup", async () => {
    const response = await post({ displayName: "Ama Owusu" });
    const { guestId, link } = await response.json();
    const guest = await findGuestById(guestId);
    expect(link).toBe(`${siteUrl()}/my/${guest?.linkToken}`);
    // The same link on a later call from that browser.
    expect((await (await post()).json()).link).toBe(link);
  });

  it("returns the same guest on later calls from that browser, making no other", async () => {
    const { guestId } = await (await post({ displayName: "Ama" })).json();
    expect((await (await post()).json()).guestId).toBe(guestId);
    expect(await guestCount()).toBe(1);
  });

  it("Ruling D: one awaited call, then three parallel calls from that browser, make one guest", async () => {
    const { guestId } = await (await post({ displayName: "Esi" })).json();
    const responses = await Promise.all([post({ displayName: "Esi" }), post({ displayName: "Esi" }), post()]);
    for (const response of responses) expect((await response.json()).guestId).toBe(guestId);
    expect(await guestCount()).toBe(1);
  });

  it("accepts no body, an empty object or a null name, keeping no name", async () => {
    const noBody = await POST(new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" } }));
    expect(noBody.status).toBe(200);
    expect((await findGuestById((await noBody.json()).guestId))?.displayName).toBeNull();

    for (const body of [{}, { displayName: null }]) {
      browserCookies.clear();
      const response = await post(body);
      expect(response.status).toBe(200);
      expect((await findGuestById((await response.json()).guestId))?.displayName).toBeNull();
    }
  });

  it("keeps a long name, cut to 80 characters", async () => {
    const { guestId } = await (await post({ displayName: "A".repeat(500) })).json();
    expect((await findGuestById(guestId))?.displayName).toBe("A".repeat(80));
  });

  it("refuses a body that isn't the expected JSON with 400, making no guest", async () => {
    const malformed = await POST(
      new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{ not json" }),
    );
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("Cache-Control")).toBe("private, no-store");
    for (const body of [{ displayName: 42 }, ["Ama"], "Ama", null]) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("bad-request");
    }
    expect(await guestCount()).toBe(0);
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("refuses anything but JSON with 415, so a form on another site can't replace the browser's cookie", async () => {
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x"]) {
      const response = await POST(
        new Request(URL_BASE, { method: "POST", headers: { "Content-Type": contentType }, body: '{"displayName":"Ama"}' }),
      );
      expect(response.status).toBe(415);
    }
    const unlabelled = await POST(new Request(URL_BASE, { method: "POST", body: new Blob(['{"displayName":"Ama"}']) }));
    expect(unlabelled.status).toBe(415);
    expect(await guestCount()).toBe(0);
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("accepts JSON with a charset", async () => {
    const response = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ displayName: "Ama" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a body over 4 KB with 413, whether or not it says its length", async () => {
    const tooLong = JSON.stringify({ displayName: "A".repeat(5_000) });
    expect((await post({ displayName: "A".repeat(5_000) })).status).toBe(413);

    const declared = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "5000000" },
        body: "{}",
      }),
    );
    expect(declared.status).toBe(413);

    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 10; chunk += 1) controller.enqueue(new TextEncoder().encode(tooLong.slice(0, 1_000)));
        controller.close();
      },
    });
    const chunked = await POST(
      new Request(URL_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: streamed,
        duplex: "half",
      } as RequestInit),
    );
    expect(chunked.status).toBe(413);
    expect(await guestCount()).toBe(0);
  });

  it("limits a browser with a cookie to 20 quick calls, then answers 429 with Retry-After", async () => {
    // Hold the limiter's clock still, so a slow machine can't refill a token mid-test.
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    const { guestId } = await (await post()).json();
    for (let call = 0; call < 20; call += 1) expect((await post()).status).toBe(200);

    const refused = await post();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("1");
    expect(refused.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await refused.json()).toMatchObject({ error: "rate-limited", retryAfterSeconds: 1 });

    // Another browser behind the same IP is not held back.
    browserCookies.clear();
    expect((await post()).status).toBe(200);
    expect((await readGuestIds())[0]).not.toBe(guestId);
  });

  it("answers 503 when the database fails, logging neither the name nor the error's message", async () => {
    database.down = true;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post({ displayName: "Secret Name" });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(browserCookies.sets).toHaveLength(0);
    const output = logged.mock.calls.flat().join(" ");
    expect(output).toContain("57014");
    expect(output).not.toContain("Secret Name");
  });

  it("never renames the browser's guest with a name it's sent, and answers the guest's own name (Ruling CG)", async () => {
    const { guestId } = await (await post({ displayName: "Ama Owusu" })).json();
    const again = await post({ displayName: "Kofi" });
    expect(await again.json()).toMatchObject({ guestId, displayName: "Ama Owusu" });
    expect((await findGuestById(guestId))?.displayName).toBe("Ama Owusu");
  });

  it("starts a new own guest when the browser's cookie names one that is gone", async () => {
    browserCookies.values.set(guestCookieName(), signGuestIds([randomUUID()]));
    const response = await post({ displayName: "Akosua" });
    expect(response.status).toBe(200);
    const { guestId } = await response.json();
    expect(await readGuestIds()).toEqual([guestId]);
  });
});

describe("PATCH /api/guest (Change, Ruling CG)", () => {
  it("renames the browser's own guest, uncached, and leaves the cookie", async () => {
    const { guestId } = await (await post({ displayName: "Kofi" })).json();
    const setsBefore = browserCookies.sets.length;
    const response = await patch({ displayName: " Kofi Boateng " });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ guestId, displayName: "Kofi Boateng" });
    expect((await findGuestById(guestId))?.displayName).toBe("Kofi Boateng");
    expect(browserCookies.sets).toHaveLength(setsBefore);
  });

  it("leaves the name for a blank one", async () => {
    const { guestId } = await (await post({ displayName: "Kofi" })).json();
    expect(await (await patch({ displayName: "  " })).json()).toEqual({ guestId, displayName: "Kofi" });
  });

  it("answers 204 for a browser without a guest, making none and setting no cookie", async () => {
    const response = await patch({ displayName: "Kofi" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await guestCount()).toBe(0);
    expect(browserCookies.sets).toHaveLength(0);
  });

  it("refuses anything but JSON with 415, and a body without a name with 400, renaming nothing", async () => {
    const { guestId } = await (await post({ displayName: "Kofi" })).json();
    expect((await patch({ displayName: "Ama" }, "text/plain")).status).toBe(415);
    for (const body of [{}, { displayName: 42 }, { displayName: null }]) expect((await patch(body)).status).toBe(400);
    expect((await findGuestById(guestId))?.displayName).toBe("Kofi");
  });
});
