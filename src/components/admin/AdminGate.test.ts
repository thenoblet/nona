import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addViewer } from "@/lib/data/admin-viewers";
import { resetDb } from "../../../test/db";

vi.mock("next/server", () => ({ connection: async () => {} }));
// redirect() ends rendering by throwing; here it throws where it was sending them.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect to ${to}`);
  },
}));

import { AdminGate } from "./AdminGate";

beforeEach(async () => {
  await resetDb();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("ADMIN_COUPLE_EMAILS", "couple@example.com");
  await addViewer("viewer@example.com", "couple@example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = (admin: { email: string; role: string }) => `the page, for the ${admin.role}`;

describe("AdminGate", () => {
  it("shows the couple every page", async () => {
    vi.stubEnv("ADMIN_DEV_EMAIL", "couple@example.com");
    expect(await AdminGate({ children: page })).toBe("the page, for the couple");
    expect(await AdminGate({ allow: "viewer", children: page })).toBe("the page, for the couple");
  });

  it("shows a viewer the Replies page and sends them there from any other", async () => {
    vi.stubEnv("ADMIN_DEV_EMAIL", "viewer@example.com");
    expect(await AdminGate({ allow: "viewer", children: page })).toBe("the page, for the viewer");
    await expect(AdminGate({ children: page })).rejects.toThrow("redirect to /admin/rsvps");
  });

  it("shows anyone else only the refusal, without rendering the page", async () => {
    vi.stubEnv("ADMIN_DEV_EMAIL", "stranger@example.com");
    const children = vi.fn(page);
    const shown = await AdminGate({ allow: "viewer", children });
    expect(JSON.stringify(shown)).toContain("This page is for the couple.");
    expect(children).not.toHaveBeenCalled();
  });
});
