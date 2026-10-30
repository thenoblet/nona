import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for pg-boss: it records how it was made and can be told to fail to start.
const fake = vi.hoisted(() => ({
  instances: [] as {
    options: Record<string, unknown>;
    listeners: Record<string, (error: Error) => void>;
    stop: ReturnType<typeof vi.fn>;
  }[],
  startError: null as Error | null,
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    options: Record<string, unknown>;
    listeners: Record<string, (error: Error) => void> = {};
    stop = vi.fn(async () => {});
    constructor(options: Record<string, unknown>) {
      this.options = options;
      fake.instances.push(this);
    }
    on(event: string, listener: (error: Error) => void) {
      this.listeners[event] = listener;
      return this;
    }
    async start() {
      if (fake.startError) throw fake.startError;
      return this;
    }
  },
}));

import { CONFIRMATION_QUEUE, getBoss } from "./boss";

const globalWithQueue = globalThis as { __nonaJobQueue?: unknown };

beforeEach(() => {
  globalWithQueue.__nonaJobQueue = null;
  fake.instances.length = 0;
  fake.startError = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getBoss", () => {
  it("connects within 5 s and cuts off any statement after 10 s", async () => {
    await getBoss();
    expect(fake.instances[0].options).toMatchObject({
      connectionTimeoutMillis: 5000,
      options: "-c statement_timeout=10000",
    });
  });

  it("stops a queue that failed to start, and starts a new one next time", async () => {
    fake.startError = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    await expect(getBoss()).rejects.toThrow("ECONNREFUSED");
    expect(fake.instances[0].stop).toHaveBeenCalledOnce();

    fake.startError = null;
    await getBoss();
    expect(fake.instances).toHaveLength(2);
  });

  it("still starts afresh when stopping the failed queue fails too", async () => {
    fake.startError = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const failedStart = getBoss();
    fake.instances[0].stop.mockRejectedValueOnce(new Error("pool already ended"));
    await expect(failedStart).rejects.toThrow("ECONNREFUSED");
    fake.startError = null;
    await expect(getBoss()).resolves.toBeDefined();
  });

  it("logs a queue error's message: its jobs carry only a reply id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await getBoss();
    fake.instances[0].listeners.error(new Error("Connection terminated unexpectedly"));
    expect(log).toHaveBeenCalledWith("Job queue error:", "Error: Connection terminated unexpectedly");
  });
});

describe("the confirmation's retries", () => {
  const HOUR = 60 * 60;
  // pg-boss 12's wait after a failed attempt with backoff (plans.js, failJobsBody): retryDelay
  // times 2^retryCount times (1 + jitter), jitter in [0, 1), capped at retryDelayMax.
  function totalWait(jitter: number): number {
    const { retryLimit, retryDelay, retryDelayMax } = CONFIRMATION_QUEUE as typeof CONFIRMATION_QUEUE & { retryDelayMax?: number };
    let seconds = 0;
    for (let retryCount = 0; retryCount < retryLimit; retryCount++) {
      const wait = retryDelay * 2 ** Math.min(16, retryCount) * (1 + jitter);
      seconds += Math.min(retryDelayMax ?? Number.POSITIVE_INFINITY, wait);
    }
    return seconds;
  }

  it("make the last attempt more than a day after the first, so a full daily quota is outlasted", () => {
    expect(CONFIRMATION_QUEUE.retryBackoff).toBe(true);
    expect(totalWait(0)).toBeGreaterThan(24 * HOUR);
  });

  it("give up within about a day and a few hours, well inside the job's retention", () => {
    expect(totalWait(1)).toBeLessThan(30 * HOUR);
    // pg-boss deletes a job left waiting to retry after retentionSeconds (14 days by default).
    const retention = (CONFIRMATION_QUEUE as { retentionSeconds?: number }).retentionSeconds ?? 14 * 24 * HOUR;
    expect(retention).toBeGreaterThan(totalWait(1));
  });
});
