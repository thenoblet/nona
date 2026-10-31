import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importJWK, SignJWT, type JWK } from "jose";

// The e2e server checks the admin as production does: a Cloudflare Access token, verified against
// the team's key set. Here the team is a local HTTPS server (cloudflare-access-server.mts) that the
// e2e server trusts through NODE_EXTRA_CA_CERTS, and the tests sign tokens with its key. A request
// without a token is still refused, like one that reaches the origin without passing Access.

export const ACCESS_PORT = 3101;
export const ACCESS_TEAM_DOMAIN = `localhost:${ACCESS_PORT}`;
export const ACCESS_AUDIENCE = "nona-e2e";
/** The key server makes its certificate and signing key here afresh each run, and removes them when stopped. */
export const ACCESS_DIR = join(tmpdir(), "nona-e2e-access");
export const ACCESS_CERT = join(ACCESS_DIR, "cert.pem");
export const ACCESS_SIGNING_KEY = join(ACCESS_DIR, "signing-key.json");
/** Cloudflare Access sends the token in this header on every request. */
export const ACCESS_HEADER = "cf-access-jwt-assertion";

/** A token like the one Cloudflare Access adds to a signed-in admin's requests. */
export async function accessToken({
  email = "couple@example.com",
  audience = ACCESS_AUDIENCE,
}: { email?: string; audience?: string } = {}): Promise<string> {
  const jwk = JSON.parse(await readFile(ACCESS_SIGNING_KEY, "utf8")) as JWK;
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(`https://${ACCESS_TEAM_DOMAIN}`)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(await importJWK(jwk, "RS256"));
}
