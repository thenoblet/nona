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
  const seeded = await saveSection("faq", [...contentDefaults.faq, { question: "E2E unique question", answer: "Yes." }], "e2e");
  if (!seeded.ok) throw new Error(`Could not seed the e2e content: ${seeded.errors.join("; ")}`);
}
