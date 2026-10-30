import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headerStore.get(name) ?? null }),
}));

import { AdminAccessError, requireAdmin, verifyAccessJwt } from "./access";

const teamDomain = "example.cloudflareaccess.com";
const audience = "example-audience-tag";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (overrides: { audience?: string; issuer?: string; expiresAt?: string | number } = {}) =>
    new SignJWT({ email: "couple@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? `https://${teamDomain}`)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? "5m")
      .sign(privateKey);
  return { jwks, sign };
}

describe("verifyAccessJwt", () => {
  it("returns the email of a valid token", async () => {
    const { jwks, sign } = await setup();
    const admin = await verifyAccessJwt(await sign(), { teamDomain, audience, jwks });
    expect(admin).toEqual({ email: "couple@example.com" });
  });

  it("rejects the wrong audience", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ audience: "someone-else" });
    await expect(verifyAccessJwt(token, { teamDomain, audience, jwks })).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 120 });
    await expect(verifyAccessJwt(token, { teamDomain, audience, jwks })).rejects.toThrow();
  });

  it("rejects the wrong issuer", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ issuer: "https://evil.example.com" });
    await expect(verifyAccessJwt(token, { teamDomain, audience, jwks })).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    const { sign } = await setup();
    const { jwks: otherJwks } = await setup();
    await expect(verifyAccessJwt(await sign(), { teamDomain, audience, jwks: otherJwks })).rejects.toThrow();
  });

  it("rejects a garbage token", async () => {
    const { jwks } = await setup();
    await expect(verifyAccessJwt("not-a-token", { teamDomain, audience, jwks })).rejects.toThrow();
  });
});

describe("requireAdmin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    headerStore.clear();
  });

  it("refuses in production without a header, even with a dev email set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_DEV_EMAIL", "dev@example.com");
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("refuses in production when the Access settings are missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", "");
    vi.stubEnv("CF_ACCESS_AUD", "");
    headerStore.set("cf-access-jwt-assertion", "anything");
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("uses the dev email outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_DEV_EMAIL", "dev@example.com");
    await expect(requireAdmin()).resolves.toEqual({ email: "dev@example.com" });
  });

  it("refuses outside production with neither a dev email nor a valid header", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ADMIN_DEV_EMAIL", "");
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);
  });
});
