import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { wishes } from "@/lib/db/schema";
import { addAlbumItem } from "../../../../../test/album";
import { resetDb } from "../../../../../test/db";

// Against the test database (docker compose up -d db).

vi.mock("next/server", () => ({ connection: async () => {} }));

const admin = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/admin/access", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/admin/access")>();
  return {
    ...real,
    requireAdmin: async () => {
      if (!admin.allowed) throw new real.AdminAccessError();
      return { email: "couple@example.com" };
    },
  };
});

import { GET as albumPage } from "./route";
import { GET as wishesPage } from "../wishes/items/route";

beforeEach(async () => {
  await resetDb();
  admin.allowed = false;
});

describe("GET /admin/photos/items", () => {
  it("refuses anyone but the couple, uncached, with no item in it", async () => {
    await addAlbumItem({ uploaderName: "Ama Owusu" });
    const response = await albumPage(new Request("https://example.com/admin/photos/items"));
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("Ama Owusu");
  });

  it("answers the couple with the next page for the filter, uncached", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 32; index += 1) {
      ids.unshift(await addAlbumItem({ uploadedAt: new Date(Date.UTC(2026, 11, 5, 18, 0, index)), uploaderName: index === 0 ? "Kofi" : "Ama Owusu" }));
    }
    admin.allowed = true;
    const first = await albumPage(new Request("https://example.com/admin/photos/items?q=ama"));
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    const firstPage = await first.json();
    expect(firstPage.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(0, 30));
    const second = await albumPage(new Request(`https://example.com/admin/photos/items?q=ama&cursor=${firstPage.nextCursor}`));
    const secondPage = await second.json();
    expect(secondPage.items.map((item: { id: string }) => item.id)).toEqual([ids[30]]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it("answers 400 for a filter the admin doesn't offer", async () => {
    admin.allowed = true;
    for (const query of ["show=everything", "celebration=honeymoon", "kind=audio", `q=${"a".repeat(81)}`]) {
      const response = await albumPage(new Request(`https://example.com/admin/photos/items?${query}`));
      expect(response.status, query).toBe(400);
    }
  });
});

describe("GET /admin/photos/wishes/items", () => {
  it("refuses anyone but the couple, and answers the couple with a page of wishes", async () => {
    await getDb().insert(wishes).values({ signedAs: "Auntie Adwoa", kind: "text", message: "A big kitchen." });
    const refused = await wishesPage(new Request("https://example.com/admin/photos/wishes/items"));
    expect(refused.status).toBe(403);
    expect(await refused.text()).not.toContain("Adwoa");

    admin.allowed = true;
    const response = await wishesPage(new Request("https://example.com/admin/photos/wishes/items"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ wishes: [{ signedAs: "Auntie Adwoa", message: "A big kitchen." }], nextCursor: null });
  });
});
