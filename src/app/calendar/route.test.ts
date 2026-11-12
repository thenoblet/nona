import { describe, expect, it, vi } from "vitest";
import { contentDefaults } from "@/lib/content/defaults";

vi.mock("@/lib/content/get", () => ({
  getSiteContent: async () => contentDefaults,
}));

vi.mock("next/server", () => ({
  connection: async () => {},
}));

import { GET } from "./route";

async function uids(query: string): Promise<string[]> {
  const response = await GET(new Request(`https://example.com/calendar${query}`));
  expect(response.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
  return [...(await response.text()).matchAll(/^UID:(.+)$/gm)].map((match) => match[1].trim());
}

describe("GET /calendar", () => {
  it("gives the celebrations asked for and ignores ids it doesn't know", async () => {
    // A link from a confirmation sent while guests were asked to the thanksgiving still names it.
    expect(await uids("?events=reception,party,thanks")).toEqual(["reception@nobletxnancy.com"]);
  });

  it("gives both when none of the ids is known", async () => {
    expect(await uids("?events=party,%3Cscript%3E")).toEqual(["ceremony@nobletxnancy.com", "reception@nobletxnancy.com"]);
  });
});
