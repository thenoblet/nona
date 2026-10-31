import { defineConfig } from "@playwright/test";
import { ACCESS_AUDIENCE, ACCESS_CERT, ACCESS_DIR, ACCESS_PORT, ACCESS_TEAM_DOMAIN } from "./e2e/cloudflare-access";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "./test/env";

// The e2e server runs a production build against the local test database and MinIO (docker compose
// up -d db minio, then npm run storage:init); the global setup starts the media worker's image
// beside it (e2e/worker.ts). RESEND_API_KEY is blank so no real email is ever sent: the
// confirmation job fails instead, which is the intended behaviour. Production refuses to sign guest
// cookies without a secret, so the e2e server gets a test-only one.
// The admin checks Cloudflare Access tokens as in production, against a local key server
// (e2e/cloudflare-access.ts). Playwright starts the servers in this order and waits for each, and
// only then runs globalSetup, so the key server's certificate exists before the e2e server starts.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3100" },
  webServer: [
    {
      command: "node e2e/cloudflare-access-server.mts",
      url: `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 2_000 },
      env: { ACCESS_PORT: String(ACCESS_PORT), ACCESS_DIR },
    },
    {
      command: "npm run build && npx next start -p 3100",
      url: "http://localhost:3100/api/healthz",
      timeout: 300_000,
      reuseExistingServer: false,
      env: {
        ...TEST_DB_ENV,
        ...TEST_STORAGE_ENV,
        ALLOW_MODE_PREVIEW: "true",
        RESEND_API_KEY: "",
        GUEST_COOKIE_SECRET: "e2e-only-guest-cookie-secret-not-used-anywhere-else",
        CF_ACCESS_TEAM_DOMAIN: ACCESS_TEAM_DOMAIN,
        CF_ACCESS_AUD: ACCESS_AUDIENCE,
        NODE_EXTRA_CA_CERTS: ACCESS_CERT,
      },
    },
  ],
});
