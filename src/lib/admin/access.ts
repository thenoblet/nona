import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { emailForAccess, isViewer } from "@/lib/data/admin-viewers";

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

// A pasted URL still works: "https://team.cloudflareaccess.com/" becomes "team.cloudflareaccess.com".
function normalizeTeamDomain(teamDomain: string): string {
  return teamDomain.trim().replace(/^https:\/\//i, "").replace(/\/+$/, "");
}

/** Checks the signature, issuer, audience and expiry of a Cloudflare Access token. */
export async function verifyAccessJwt(token: string, options: VerifyOptions): Promise<{ email: string }> {
  const teamDomain = normalizeTeamDomain(options.teamDomain);
  const { payload } = await jwtVerify(token, options.jwks ?? remoteKeySet(teamDomain), {
    issuer: `https://${teamDomain}`,
    audience: options.audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp"],
  });
  if (typeof payload.email !== "string" || payload.email === "") throw new AdminAccessError();
  return { email: payload.email };
}

/**
 * Proves the request came through Cloudflare Access, and returns the email it signed in with.
 * Who that is (the couple, a viewer, or nobody the admin knows) is identifyAdmin's question.
 */
async function signedInEmail(): Promise<{ email: string }> {
  // Development only: a stand-in so the admin works locally without Cloudflare in front.
  const devEmail = process.env.ADMIN_DEV_EMAIL;
  if (process.env.NODE_ENV !== "production" && devEmail) return { email: devEmail };

  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN;
  const audience = process.env.CF_ACCESS_AUD;
  // Missing settings refuse access; they never skip the check.
  if (!teamDomain || !audience) {
    console.warn("Admin access refused: settings missing");
    throw new AdminAccessError();
  }
  const token = (await headers()).get("cf-access-jwt-assertion");
  if (!token) {
    console.warn("Admin access refused: no token");
    throw new AdminAccessError();
  }

  try {
    return await verifyAccessJwt(token, { teamDomain, audience });
  } catch (error) {
    // Only the error's name and code are logged, never the token, its claims or the email.
    const name = error instanceof Error ? error.name : "unknown error";
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(`Admin access refused: token rejected (${name}${typeof code === "string" ? ` ${code}` : ""})`);
    throw new AdminAccessError();
  }
}

/**
 * The couple: everything in the admin. A viewer: the Replies list and its downloads, read-only.
 * See identifyAdmin for how each is decided.
 */
export type AdminRole = "couple" | "viewer";
export type AdminIdentity = { email: string; role: AdminRole };

/** The couple's sign-in emails, from ADMIN_COUPLE_EMAILS (comma-separated), or null when it is unset. */
export function coupleEmails(): string[] | null {
  const listed = (process.env.ADMIN_COUPLE_EMAILS ?? "")
    .split(",")
    .map(emailForAccess)
    .filter((email) => email !== "");
  return listed.length > 0 ? listed : null;
}

/**
 * Who this request is, once Cloudflare Access let it through:
 * - the couple, when ADMIN_COUPLE_EMAILS names the email (it lives in the server's settings, so
 *   the couple can never lock themselves out from the admin);
 * - a viewer, when the couple added the email in People with access (and haven't removed it);
 * - nobody, otherwise: AdminAccessError, as for no sign-in at all.
 * With ADMIN_COUPLE_EMAILS unset, everyone Access lets through who isn't a viewer is the couple,
 * as before roles existed. Read once per request.
 */
export const identifyAdmin = cache(async (): Promise<AdminIdentity> => {
  const { email } = await signedInEmail();
  const couple = coupleEmails();
  const key = emailForAccess(email);
  if (couple?.includes(key)) return { email, role: "couple" };
  if (await isViewer(key)) return { email, role: "viewer" };
  if (couple === null) return { email, role: "couple" };
  console.warn("Admin access refused: signed in, but neither the couple nor a viewer");
  throw new AdminAccessError();
});

/**
 * The couple only. Call it from every admin page, route and action that changes anything or shows
 * more than the Replies list: a viewer, a request that skips the edge, or one that hits the origin
 * directly gets nothing.
 */
export async function requireAdmin(): Promise<{ email: string }> {
  const { email, role } = await identifyAdmin();
  if (role !== "couple") {
    console.warn("Admin access refused: a viewer asked for something only the couple can do");
    throw new AdminAccessError();
  }
  return { email };
}

/** The couple or a viewer: only for reading the Replies list and downloading it. */
export async function requireViewerOrCouple(): Promise<AdminIdentity> {
  return identifyAdmin();
}
