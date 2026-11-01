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

function albumRequest(query = ""): Request {
  return new Request(`https://example.com/api/album${query}`);
}

type PageBody = { items: AlbumItem[]; nextCursor: string | null; newestCursor: string | null };

async function page(query = ""): Promise<PageBody> {
  const response = await GET(albumRequest(query));
  expect(response.status).toBe(200);
  return response.json();
}

/** Ready photos listed a second apart, ending a minute ago; their ids, newest first. */
async function listed(count: number, overrides: Parameters<typeof addAlbumItem>[0] = {}): Promise<string[]> {
  const ids: string[] = [];
  const first = Date.now() - 60_000 - count * 1000;
  for (let index = 0; index < count; index += 1) ids.push(await addAlbumItem({ listedAt: new Date(first + index * 1000), ...overrides }));
  return ids.reverse();
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

describe("GET /api/album", () => {
  it("answers the first 30 moments, newest first, and the cursor the next page starts from, never cached", async () => {
    const ids = await listed(31);
    const response = await GET(albumRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const first: PageBody = await response.json();
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 30));
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.newestCursor).toEqual(expect.any(String));

    const second = await page(`?cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.id)).toEqual([ids[30]]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by celebration and by Photos or Videos, and My uploads shows the browser's own, waiting ones too", async () => {
    const guest = await createGuest("Ama Owusu");
    const video = await addAlbumItem({ kind: "video", celebration: "more" });
    const photo = await addAlbumItem({ celebration: "ceremony" });
    const own = await addAlbumItem({ guestId: guest.id, celebration: "ceremony" });
    const waiting = await addAlbumItem({ guestId: guest.id, status: "uploaded" });

    expect((await page("?kind=video")).items.map((item) => item.id)).toEqual([video]);
    expect((await page("?celebration=more")).items.map((item) => item.id)).toEqual([video]);
    expect((await page("?celebration=ceremony&kind=photo")).items.map((item) => item.id).sort()).toEqual([photo, own].sort());
    // Without the cookie, My uploads is empty and nothing reads as anyone's own.
    expect((await page("?view=mine")).items).toEqual([]);
    expect((await page()).items.some((item) => item.mine)).toBe(false);

    asGuests(guest.id);
    const mine = await page("?view=mine");
    expect(mine.items.map((item) => item.id)).toEqual([waiting, own]);
    expect(mine.items[0]).toMatchObject({ status: "uploaded", mine: true });
  });

  it("answers the moments listed since a page's newest, for the pill", async () => {
    await listed(3);
    const { newestCursor } = await page();
    const fresh = await addAlbumItem({});
    const newer = await GET(albumRequest(`?newer=${newestCursor}`));
    expect(newer.status).toBe(200);
    expect(await newer.json()).toMatchObject({ items: [expect.objectContaining({ id: fresh })], complete: true, newestCursor: expect.any(String) });
  });

  it("refuses a filter it doesn't know, and a newer cursor it didn't make, with 400", async () => {
    for (const query of ["?kind=audio", "?celebration=wedding", "?view=theirs", "?newer=nonsense"]) {
      const response = await GET(albumRequest(query));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });

  it("is limited per guest once the browser has one: past the burst it answers 429 with Retry-After", async () => {
    const guest = await createGuest("Ama Owusu");
    asGuests(guest.id);
    for (let request = 0; request < RATE_LIMITS.album.burst; request += 1) takeToken(guest.id, "album");
    const response = await GET(albumRequest());
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
