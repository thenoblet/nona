import { contentDefaults } from "../src/lib/content/defaults";
import { saveSection } from "../src/lib/content/store";
import { runMigrations } from "../src/lib/db/migrate";
import { resetDb, saveTestSetting } from "../test/db";
import { TEST_DB_ENV } from "../test/env";
import { startWorker } from "./worker";

/** Prepares the test database and starts the media worker; returns the teardown that stops it. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  // The database modules read these when they connect, so set them first.
  Object.assign(process.env, TEST_DB_ENV);
  await runMigrations();
  await resetDb();
  // Uploads start closed in a new database; the e2e guests find them open, as on the day.
  await saveTestSetting("uploads_open", true);
  await saveTestSetting("uploads_closed_at", null);
  const seeded = await saveSection("faq", [...contentDefaults.faq, { question: "E2E unique question", answer: "Yes." }], "e2e");
  if (!seeded.ok) throw new Error(`Could not seed the e2e content: ${seeded.errors.join("; ")}`);
  // Last, once the database has every migration the worker waits for.
  return startWorker();
}
