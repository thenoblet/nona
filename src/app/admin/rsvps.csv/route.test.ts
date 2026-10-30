import { beforeEach, describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";
import { keepReply, saveRsvp } from "@/lib/data/rsvp";
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

describe("GET /admin/rsvps.csv", () => {
  it("refuses with 403 and no replies when the request is not from the couple", async () => {
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body = await response.text();
    expect(body).not.toContain("Ama Owusu");
    expect(body).not.toContain("ama@example.com");
  });

  it("downloads every current reply as a dated, uncached CSV for the couple", async () => {
    admin.allowed = true;
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="nona-rsvps-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const lines = (await response.text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe(
      "Name,Phone,Email,Party size,White wedding,Reception,Thanksgiving service,Other names,Song,Received,Email status,Flags",
    );
    expect(lines[1]).toMatch(/^Ama Owusu,024 000 0000,ama@example\.com,2 people,Yes,No,,,'=Odo,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Not sent,$/);
    expect(lines).toHaveLength(3);
  });

  it("lists each flag in words and leaves out replies moved into a history", async () => {
    admin.allowed = true;
    await saveRsvp({
      fullName: "Ama Owusu",
      phone: "+233 24 000 0000",
      partySize: "Just me",
      answers: { ceremony: "yes" },
    });
    const moved = await saveRsvp({ fullName: "Kofi Mensah", phone: "055 111 2222", partySize: "Just me", answers: { ceremony: "no" } });
    const kept = await saveRsvp({ fullName: "Kofi Mensah", phone: "055 111 2222", partySize: "2 people", answers: { ceremony: "no" } });
    await keepReply(kept.record.id, [moved.record.id]);

    const lines = (await (await GET()).text()).replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines.filter((line) => line.startsWith("Kofi Mensah,"))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith("Kofi Mensah,"))).toMatch(/,2 people,/);
    expect(lines.find((line) => line.startsWith("Ama Owusu,'+233"))).toMatch(
      /,Replied again: Ama Owusu \(same phone\)$/,
    );
  });
});
