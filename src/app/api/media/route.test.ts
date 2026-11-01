import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import type { AlbumItem } from "@/lib/media/album-item";
import { addAlbumItem } from "../../../../test/album";
import { resetDb } from "../../../../test/db";
import { browserCookies } from "../../../../test/next-cookies";

// Against the test database (docker compose up -d db).

vi.mock("next/headers", () => import("../../../../test/next-cookies"));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

function asGuests(...guestIds: string[]): void {
  browserCookies.values.set(guestCookieName(), signGuestIds(guestIds));
}

function itemsRequest(ids: string[]): Request {
  return new Request(`https://example.com/api/media?ids=${ids.join(",")}`);
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

// Fix round 1, Important #2: the album's waiting tiles and the uploader's cards ask after all their
// moments in one request, so an honest guest's checks never run into the `item` limit.
describe("GET /api/media?ids=", () => {
  it("answers every named moment as the album has it now, in one request: ready ones for anyone, the browser's own waiting or failed ones", async () => {
    const guest = await createGuest("Ama Owusu");
    const stranger = await createGuest("Yaw Boateng");
    asGuests(guest.id);
    const ready = await addAlbumItem({});
    const waiting = await addAlbumItem({ guestId: guest.id, status: "uploaded" });
    const failed = await addAlbumItem({ guestId: guest.id, status: "failed", failureReason: "corrupt" });
    const theirs = await addAlbumItem({ guestId: stranger.id, status: "uploaded" });
    const hidden = await addAlbumItem({ guestId: guest.id, hiddenAt: new Date(), hiddenBy: "noblet" });

    const response = await GET(itemsRequest([ready, waiting, failed, theirs, hidden, randomUUID()]));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { items } = (await response.json()) as { items: AlbumItem[] };
    expect(Object.fromEntries(items.map((item) => [item.id, item.status]))).toEqual({ [ready]: "ready", [waiting]: "uploaded", [failed]: "failed" });
  });

  it("takes one request from the guest's bucket however many moments it names", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    const ids = await Promise.all(Array.from({ length: 50 }, () => addAlbumItem({ guestId: guest.id, status: "uploaded" })));
    for (let request = 0; request < RATE_LIMITS.item.burst - 1; request += 1) takeToken(guest.id, "item");

    expect((await GET(itemsRequest(ids))).status).toBe(200);
    expect((await GET(itemsRequest(ids))).status).toBe(429);
  });

  it("refuses more than 50 ids, or none, with 400, and skips what isn't an id", async () => {
    expect((await GET(itemsRequest(Array.from({ length: 51 }, () => randomUUID())))).status).toBe(400);
    expect((await GET(new Request("https://example.com/api/media"))).status).toBe(400);
    const ready = await addAlbumItem({});
    const answer = await GET(itemsRequest([ready, "not-an-id"]));
    expect(((await answer.json()) as { items: AlbumItem[] }).items.map((item) => item.id)).toEqual([ready]);
  });
});
