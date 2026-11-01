import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { addAlbumItem } from "../../../../../test/album";
import { resetDb } from "../../../../../test/db";
import { browserCookies } from "../../../../../test/next-cookies";
import { routeContext } from "../../../../../test/uploads";

// Against the test database (docker compose up -d db).

vi.mock("next/headers", () => import("../../../../../test/next-cookies"));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

function asGuests(...guestIds: string[]): void {
  browserCookies.values.set(guestCookieName(), signGuestIds(guestIds));
}

function itemRequest(mediaId: string): Request {
  return new Request(`https://example.com/api/media/${mediaId}`);
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

describe("GET /api/media/[id]", () => {
  it("answers a ready, visible moment to anyone, with its thumbnail and the versions a phone plays, never cached", async () => {
    const mediaId = await addAlbumItem({});
    const response = await GET(itemRequest(mediaId), routeContext(mediaId));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      item: expect.objectContaining({ id: mediaId, status: "ready", mine: false, thumb: expect.stringMatching(/\/thumb\.webp$/) }),
    });
  });

  it("answers the browser's own moment while it is being made ready, or failed, with its reason; to no one else", async () => {
    const guest = await createGuest("Ama Owusu");
    const waiting = await addAlbumItem({ guestId: guest.id, status: "uploaded" });
    const failed = await addAlbumItem({ guestId: guest.id, status: "failed", failureReason: "too-large" });

    expect((await GET(itemRequest(waiting), routeContext(waiting))).status).toBe(404);
    asGuests(guest.id);
    expect((await (await GET(itemRequest(waiting), routeContext(waiting))).json()).item).toMatchObject({ status: "uploaded", mine: true, thumb: null });
    expect((await (await GET(itemRequest(failed), routeContext(failed))).json()).item).toMatchObject({ status: "failed", failure: "too-large" });
  });

  it("answers 404 for a hidden, removed or deleted moment, a wish, and an id that isn't one", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const ids = [
      await addAlbumItem({ guestId: guest.id, hiddenAt: new Date(), hiddenBy: "noblet" }),
      await addAlbumItem({ guestId: guest.id, hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
      await addAlbumItem({ deletedAt: new Date() }),
      await addAlbumItem({ purpose: "wish", kind: "video" }),
      randomUUID(),
      "not-an-id",
    ];
    for (const mediaId of ids) {
      const response = await GET(itemRequest(mediaId), routeContext(mediaId));
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("is limited per guest once the browser has one: past the burst it answers 429 with Retry-After", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const mediaId = await addAlbumItem({});
    for (let request = 0; request < RATE_LIMITS.item.burst; request += 1) takeToken(guest.id, "item");
    const response = await GET(itemRequest(mediaId), routeContext(mediaId));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
