import "server-only";
import { headers } from "next/headers";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/** Thrown when a request is not from the couple. The message is fixed so it never says why. */
export class AdminAccessError extends Error {
  constructor() {
    super("Admin access refused");
    this.name = "AdminAccessError";
  }
}

type VerifyOptions = { teamDomain: string; audience: string; jwks?: JWTVerifyGetKey };

// One key set per team domain, created on first use so jose's key cache is reused across requests.
const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(teamDomain: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(teamDomain);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`), {
      timeoutDuration: 5_000,
    });
    remoteKeySets.set(teamDomain, keySet);
  }
  return keySet;
}

/** Checks the signature, issuer, audience and expiry of a Cloudflare Access token. */
export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<{ email: string }> {
  const { payload } = await jwtVerify(token, options.jwks ?? remoteKeySet(options.teamDomain), {
    issuer: `https://${options.teamDomain}`,
    audience: options.audience,
  });
  if (typeof payload.email !== "string" || payload.email === "") throw new AdminAccessError();
  return { email: payload.email };
}

/**
 * Proves the request came through Cloudflare Access as the couple. Call it from every admin page,
 * route and action: a request that skips the edge or hits the origin directly gets nothing.
 */
export async function requireAdmin(): Promise<{ email: string }> {
  // Development only: a stand-in so the admin works locally without Cloudflare in front.
  const devEmail = process.env.ADMIN_DEV_EMAIL;
  if (process.env.NODE_ENV !== "production" && devEmail) return { email: devEmail };

  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CF_ACCESS_AUD;
  const token = (await headers()).get("cf-access-jwt-assertion");
  // Missing settings refuse access; they never skip the check.
  if (!teamDomain || !audience || !token) throw new AdminAccessError();

  try {
    return await verifyAccessJwt(token, { teamDomain, audience });
  } catch (error) {
    // Only jose's error code is logged, never the token or its claims.
    const code = (error as { code?: unknown }).code;
    console.warn(`Admin access refused (${typeof code === "string" ? code : "verification failed"})`);
    throw new AdminAccessError();
  }
}
