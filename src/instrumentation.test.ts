import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startUp = vi.hoisted(() => {
  const jobs = vi.fn(async () => {});
  return {
    configured: true,
    migrations: vi.fn(async () => {}),
    jobs,
    /** The job queue module every test loads in place of the real one, which would start pg-boss. */
    standInJobs: () => ({ startJobs: jobs }),
  };
});

vi.mock("@/lib/env", () => ({ isDbConfigured: () => startUp.configured }));
vi.mock("@/lib/db/migrate", () => ({ runMigrations: startUp.migrations }));
vi.mock("@/lib/jobs/boss", () => startUp.standInJobs());

/** A fresh copy of the file, so each test's mocks apply to its imports. */
async function loadRegister() {
  vi.resetModules();
  return (await import("./instrumentation")).register;
}

beforeEach(() => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("NEXT_PHASE", "");
  startUp.configured = true;
  startUp.migrations.mockClear();
  startUp.jobs.mockClear();
});

afterEach(() => {
  // A test may swap the job queue module for one that fails to load: the next one gets the stand-in back.
  vi.doMock("@/lib/jobs/boss", () => startUp.standInJobs());
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("register", () => {
  it("runs the migrations, then starts the job queue in the background", async () => {
    const register = await loadRegister();
    await register();
    expect(startUp.migrations).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(startUp.jobs).toHaveBeenCalledOnce());
  });

  it("warns once, in fixed words, when the database settings are missing in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    startUp.configured = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const register = await loadRegister();
    await register();
    expect(warn.mock.calls).toEqual([["Database settings missing: migrations and the job queue are off"]]);
    expect(startUp.migrations).not.toHaveBeenCalled();
  });

  it("never throws, even when a start-up module fails to load", async () => {
    vi.doMock("@/lib/jobs/boss", () => {
      throw new Error("Cannot find module 'pg-boss'");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const register = await loadRegister();
    await expect(register()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("gives every test the stand-in job queue, never the real one", async () => {
    const register = await loadRegister();
    await register();
    await vi.waitFor(() => expect(startUp.jobs).toHaveBeenCalledOnce());
  });
});
