import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { TEST_DB_ENV } from "./test/env";

// globalSetup runs in the main process and doesn't see test.env, so set it here.
Object.assign(process.env, TEST_DB_ENV);

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": fromRoot("./src"),
      "server-only": fromRoot("./test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false,
  },
});
