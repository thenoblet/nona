import { afterEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "./site-url";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("siteUrl", () => {
  it("drops trailing slashes", () => {
    vi.stubEnv("SITE_URL", "https://nobletxnancy.com//");
    expect(siteUrl()).toBe("https://nobletxnancy.com");
  });

  it("is the local address when SITE_URL is empty or unset", () => {
    vi.stubEnv("SITE_URL", "");
    expect(siteUrl()).toBe("http://localhost:3000");
    vi.stubEnv("SITE_URL", undefined);
    expect(siteUrl()).toBe("http://localhost:3000");
  });
});
