import { defineConfig } from "@playwright/test";
import { TEST_DB_ENV } from "./test/env";

// The e2e server runs a production build against the local test database. RESEND_API_KEY is blank
// so no real email is ever sent: the confirmation job fails instead, which is the intended behaviour.
// Production refuses to sign guest cookies without a secret, so the e2e server gets a test-only one.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:3100" },
  webServer: {
    command: "npm run build && npx next start -p 3100",
    url: "http://localhost:3100/api/healthz",
    timeout: 300_000,
    reuseExistingServer: false,
    env: {
      ...TEST_DB_ENV,
      ALLOW_MODE_PREVIEW: "true",
      RESEND_API_KEY: "",
      GUEST_COOKIE_SECRET: "e2e-only-guest-cookie-secret-not-used-anywhere-else",
    },
  },
});
