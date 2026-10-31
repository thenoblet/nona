import { configDefaults, defineConfig } from "vitest/config";
import appConfig from "./vitest.config";

/**
 * The media worker's tests (npm run test:worker). They run ffmpeg and libheif's tools, so they run
 * in the worker image's test target (Dockerfile.worker), against the same database and MinIO as
 * npm test. Everything else is npm test's.
 */
export default defineConfig({
  ...appConfig,
  test: {
    ...appConfig.test,
    include: ["src/worker/**/*.test.ts"],
    exclude: configDefaults.exclude,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
