import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { listAlbum } from "@/lib/media/album";
import { addAlbumItem } from "../../../../../test/album";
import { resetDb } from "../../../../../test/db";
import { browserCookies } from "../../../../../test/next-cookies";

// Against the test database (docker compose up -d db).

vi.mock("next/headers", () => import("../../../../../test/next-cookies"));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

function newRequest(query: string): Request {
  return new Request(`https://example.com/api/album/new${query}`);
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

describe("GET /api/album/new", () => {
  it("counts the moments listed since the page's newest, following its filters, never cached", async () => {
    const guest = await createGuest("Ama Owusu");
    await addAlbumItem({ listedAt: new Date(Date.now() - 60_000) });
    const { newestCursor } = await listAlbum({ viewerGuestIds: [] });
    await addAlbumItem({});
    await addAlbumItem({ kind: "video" });
    await addAlbumItem({ kind: "video", guestId: guest.id });

    const all = await GET(newRequest(`?since=${newestCursor}`));
    expect(all.status).toBe(200);
    expect(all.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await all.json();
    expect(body.count).toBe(3);
    expect(body.newest).toHaveLength(3);

    expect((await (await GET(newRequest(`?since=${newestCursor}&kind=video`))).json()).count).toBe(2);
    expect((await (await GET(newRequest(`?since=${newestCursor}&kind=photo`))).json()).count).toBe(1);
    browserCookies.values.set(guestCookieName(), signGuestIds([guest.id]));
    expect((await (await GET(newRequest(`?since=${newestCursor}&view=mine`))).json()).count).toBe(1);
  });

  it("refuses a missing or foreign cursor, and a filter it doesn't know, with 400", async () => {
    for (const query of ["", "?since=nonsense", `?since=${"a".repeat(20)}&kind=audio`]) {
      expect((await GET(newRequest(query))).status).toBe(400);
    }
  });

  it("is limited per guest once the browser has one", async () => {
    const guest = await createGuest("Ama Owusu");
    browserCookies.values.set(guestCookieName(), signGuestIds([guest.id]));
    await addAlbumItem({});
    const { newestCursor } = await listAlbum({ viewerGuestIds: [] });
    for (let request = 0; request < RATE_LIMITS.album.burst; request += 1) takeToken(guest.id, "album");
    expect((await GET(newRequest(`?since=${newestCursor}`))).status).toBe(429);
  });
});
