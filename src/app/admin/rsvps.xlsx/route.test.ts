import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { saveRsvp } from "@/lib/data/rsvp";
import { resetDb } from "../../../../test/db";

vi.mock("@/lib/content/get", () => ({
  getSiteContent: async () => contentDefaults,
}));

vi.mock("next/server", () => ({
  connection: async () => {},
}));

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

import { GET } from "./route";

beforeEach(async () => {
  await resetDb();
  admin.allowed = false;
  await saveRsvp({
    fullName: "Ama Owusu",
    phone: "024 000 0000",
    email: "ama@example.com",
    partySize: "2 people",
    answers: { ceremony: "yes", reception: "no" },
    song: "=Odo",
  });
});

describe("GET /admin/rsvps.xlsx", () => {
  it("refuses with 403 and no replies when the request is not from the couple", async () => {
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("Ama Owusu");
  });

  it("downloads every current reply as a dated, uncached Excel workbook for the couple", async () => {
    admin.allowed = true;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment; filename="nona-rsvps-\d{4}-\d{2}-\d{2}\.xlsx"$/);

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // Stored, not compressed, so the sheet's text is in the bytes as written.
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('<t xml:space="preserve">Name</t>');
    expect(text).toContain('<t xml:space="preserve">Ama Owusu</t>');
    expect(text).toContain('<t xml:space="preserve">024 000 0000</t>');
    expect(text).toContain('<t xml:space="preserve">=Odo</t>');
    expect(text).toContain('<sheet name="Replies"');
  });
});
