import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import { TEST_DB_ENV, TEST_STORAGE_ENV } from "./test/env";

// globalSetup runs in the main process and doesn't see test.env, so set it here.
Object.assign(process.env, TEST_DB_ENV, TEST_STORAGE_ENV);

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
    // The media worker's tests run ffmpeg and libheif's tools: npm run test:worker, in its image.
    exclude: [...configDefaults.exclude, "src/worker/**"],
    fileParallelism: false,
  },
});
