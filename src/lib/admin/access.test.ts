import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

const localKeySet = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("jose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jose")>()),
  createRemoteJWKSet: () => localKeySet.current,
}));

const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headerStore.get(name) ?? null }),
}));

import { addViewer, removeViewer } from "@/lib/data/admin-viewers";
import { resetDb } from "../../../test/db";
import { AdminAccessError, coupleEmails, identifyAdmin, requireAdmin, requireViewerOrCouple, verifyAccessJwt } from "./access";

const teamDomain = "example.cloudflareaccess.com";
const audience = "example-audience-tag";

async function setup() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    overrides: { audience?: string; issuer?: string; expiresAt?: string | number | null; claims?: Record<string, unknown> } = {},
  ) => {
    const builder = new SignJWT(overrides.claims ?? { email: "couple@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? `https://${teamDomain}`)
      .setAudience(overrides.audience ?? audience)
      .setIssuedAt();
    if (overrides.expiresAt !== null) builder.setExpirationTime(overrides.expiresAt ?? "5m");
    return builder.sign(privateKey);
  };
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

  it("rejects a token without an expiry", async () => {
    const { jwks, sign } = await setup();
    const token = await sign({ expiresAt: null });
    await expect(verifyAccessJwt(token, { teamDomain, audience, jwks })).rejects.toThrow();
  });

  it("rejects a token without an email, or with an empty one", async () => {
    const { jwks, sign } = await setup();
    for (const claims of [{}, { email: "" }]) {
      const token = await sign({ claims });
      await expect(verifyAccessJwt(token, { teamDomain, audience, jwks })).rejects.toBeInstanceOf(AdminAccessError);
    }
  });

  it("accepts a team domain pasted as a URL", async () => {
    const { jwks, sign } = await setup();
    const admin = await verifyAccessJwt(await sign(), { teamDomain: `https://${teamDomain}/`, audience, jwks });
    expect(admin.email).toBe("couple@example.com");
  });

  it("rejects a garbage token", async () => {
    const { jwks } = await setup();
    await expect(verifyAccessJwt("not-a-token", { teamDomain, audience, jwks })).rejects.toThrow();
  });
});

describe("requireAdmin", () => {
  beforeEach(async () => {
    await resetDb();
  });

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

  it("accepts a valid header in production and refuses a missing one", async () => {
    const { jwks, sign } = await setup();
    localKeySet.current = jwks;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CF_ACCESS_TEAM_DOMAIN", teamDomain);
    vi.stubEnv("CF_ACCESS_AUD", audience);
    headerStore.set("cf-access-jwt-assertion", await sign());
    await expect(requireAdmin()).resolves.toEqual({ email: "couple@example.com" });
    headerStore.delete("cf-access-jwt-assertion");
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

describe("roles", () => {
  beforeEach(async () => {
    await resetDb();
    vi.stubEnv("NODE_ENV", "development");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Signs in as this email, the way the dev stand-in does. */
  function signInAs(email: string) {
    vi.stubEnv("ADMIN_DEV_EMAIL", email);
  }

  it("reads the couple's emails from the server's settings, trimmed and lowercased", () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", " Noblet@Example.com, nancy@example.com ,, ");
    expect(coupleEmails()).toEqual(["noblet@example.com", "nancy@example.com"]);
    vi.stubEnv("ADMIN_COUPLE_EMAILS", " , ");
    expect(coupleEmails()).toBeNull();
  });

  it("knows the couple however Access spells their email", async () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", "noblet@example.com,nancy@example.com");
    signInAs("NANCY@example.com");
    await expect(identifyAdmin()).resolves.toEqual({ email: "NANCY@example.com", role: "couple" });
    await expect(requireAdmin()).resolves.toEqual({ email: "NANCY@example.com" });
  });

  it("lets a viewer read but refuses them anything only the couple can do", async () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", "noblet@example.com");
    await addViewer("ama@example.com", "noblet@example.com");
    signInAs("Ama@Example.com");
    await expect(requireViewerOrCouple()).resolves.toEqual({ email: "Ama@Example.com", role: "viewer" });
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("refuses someone Access let through whom the admin doesn't know, and a removed viewer", async () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", "noblet@example.com");
    signInAs("stranger@example.com");
    await expect(requireViewerOrCouple()).rejects.toBeInstanceOf(AdminAccessError);
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);

    const added = await addViewer("ama@example.com", "noblet@example.com");
    if (added.status !== "added") throw new Error("not added");
    await removeViewer(added.viewer.id, "noblet@example.com");
    signInAs("ama@example.com");
    await expect(requireViewerOrCouple()).rejects.toBeInstanceOf(AdminAccessError);
  });

  it("treats an email in both lists as the couple", async () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", "noblet@example.com");
    await addViewer("noblet@example.com", "nancy@example.com");
    signInAs("noblet@example.com");
    await expect(identifyAdmin()).resolves.toMatchObject({ role: "couple" });
  });

  it("without the couple's emails set, keeps today's admin: everyone but a viewer is the couple", async () => {
    vi.stubEnv("ADMIN_COUPLE_EMAILS", "");
    signInAs("anyone@example.com");
    await expect(identifyAdmin()).resolves.toMatchObject({ role: "couple" });
    await addViewer("ama@example.com", "anyone@example.com");
    signInAs("ama@example.com");
    await expect(identifyAdmin()).resolves.toMatchObject({ role: "viewer" });
    await expect(requireAdmin()).rejects.toBeInstanceOf(AdminAccessError);
  });
});
