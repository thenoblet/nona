// The Cloudflare Access team's key server, for the e2e tests (see cloudflare-access.ts). Playwright
// starts it before the e2e server and waits for it, so the certificate exists before the e2e server
// starts and reads NODE_EXTRA_CA_CERTS. Nothing here is committed: openssl makes a certificate for
// localhost, and jose a token-signing key pair, each run. The public key is served where
// requireAdmin() looks for it; the private key is left for the tests to sign tokens with.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";

const port = Number(process.env.ACCESS_PORT);
const directory = process.env.ACCESS_DIR;
if (!port || !directory) throw new Error("Set ACCESS_PORT and ACCESS_DIR");

rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true, mode: 0o700 });
const certFile = join(directory, "cert.pem");
const tlsKeyFile = join(directory, "tls-key.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
  "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", tlsKeyFile, "-out", certFile,
], { stdio: "ignore" });

const keyId = "nona-e2e";
const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
const signingKey = { ...(await exportJWK(privateKey)), kid: keyId, alg: "RS256" };
writeFileSync(join(directory, "signing-key.json"), JSON.stringify(signingKey), { mode: 0o600 });
const keySet = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: keyId, alg: "RS256", use: "sig" }] });

const server = createServer({ key: readFileSync(tlsKeyFile), cert: readFileSync(certFile) }, (request, response) => {
  if (request.url !== "/cdn-cgi/access/certs") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" }).end(keySet);
});
server.listen(port);

// Playwright stops it with SIGTERM (gracefulShutdown in playwright.config.ts): take the keys with it.
process.on("SIGTERM", () => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
});
