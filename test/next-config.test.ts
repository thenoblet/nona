import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config headers", () => {
  it("keeps a personal link and its question out of every other site's frames (Ruling CG)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const linkRule = rules.find((rule) => rule.source === "/my/:path*");
    expect(linkRule?.headers).toEqual(
      expect.arrayContaining([
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ]),
    );
  });
});
