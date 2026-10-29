const RETRY_MS = 30_000;

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // Node-only modules are imported here so the Edge build never sees them.
  const { isDbConfigured } = await import("@/lib/env");
  if (!isDbConfigured()) return;
  const { runMigrations } = await import("@/lib/db/migrate");
  const { startJobs } = await import("@/lib/jobs/boss");

  const start = async () => {
    try {
      await runMigrations();
      await startJobs();
    } catch (error) {
      console.error("Database start-up failed; retrying in 30 s", error);
      setTimeout(start, RETRY_MS).unref();
    }
  };
  await start();
}
