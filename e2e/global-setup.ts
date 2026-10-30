import { contentDefaults } from "../src/lib/content/defaults";
import { saveSection } from "../src/lib/content/store";
import { runMigrations } from "../src/lib/db/migrate";
import { resetDb } from "../test/db";
import { TEST_DB_ENV } from "../test/env";

export default async function globalSetup(): Promise<void> {
  // The database modules read these when they connect, so set them first.
  Object.assign(process.env, TEST_DB_ENV);
  await runMigrations();
  await resetDb();
  await saveSection("faq", [...contentDefaults.faq, { q: "E2E unique question", a: "Yes." }], "e2e");
}
