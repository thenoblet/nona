import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_TRACKED_BUCKETS, RATE_LIMITS, rateLimitedResponse, takeToken, type RateLimitBucket } from "./rate-limit";

// The counts live on globalThis so every server bundle in the process shares them.
function trackedBuckets(): Map<string, unknown> {
  const tracked = (globalThis as { __nonaRateLimits?: Map<string, unknown> }).__nonaRateLimits;
  if (!tracked) throw new Error("the rate limiter keeps no counts on globalThis");
  return tracked;
}

/** Takes `count` tokens at the same instant and returns how many were allowed. */
function takeMany(guestId: string, bucket: RateLimitBucket, count: number, now: number): number {
  let allowed = 0;
  for (let request = 0; request < count; request += 1) {
    if (takeToken(guestId, bucket, now).allowed) allowed += 1;
  }
  return allowed;
}

const UPLOAD_BUCKETS = ["start", "presign", "events", "playable", "download", "wish"] as const;

beforeEach(() => {
  // Make sure the map exists, then empty it, so each test starts from nothing.
  takeToken(randomUUID(), "start", 0);
  trackedBuckets().clear();
});

describe("takeToken", () => {
  it("allows a burst of 100 in every upload bucket, then refuses the 101st with how long to wait", () => {
    for (const bucket of UPLOAD_BUCKETS) {
      const guestId = randomUUID();
      expect(takeMany(guestId, bucket, 100, 1_000)).toBe(100);
      expect(takeToken(guestId, bucket, 1_000)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    }
  });

  it("answers an allowed request with no wait", () => {
    expect(takeToken(randomUUID(), "start", 1_000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("refills at 2 per second, up to the burst again", () => {
    const guestId = randomUUID();
    takeMany(guestId, "presign", 100, 0);
    expect(takeToken(guestId, "presign", 0).allowed).toBe(false);
    expect(takeToken(guestId, "presign", 499).allowed).toBe(false);
    expect(takeToken(guestId, "presign", 500).allowed).toBe(true);
    expect(takeToken(guestId, "presign", 500).allowed).toBe(false);
    expect(takeMany(guestId, "presign", 10, 5_500)).toBe(10);
    // Idle for a long time: the burst is back, and never more than the burst.
    expect(takeMany(guestId, "presign", 150, 3_600_000)).toBe(100);
  });

  it("Review Focus 4: two guests behind one IP have separate buckets", () => {
    const [firstGuest, secondGuest] = [randomUUID(), randomUUID()];
    expect(takeMany(firstGuest, "start", 101, 1_000)).toBe(100);
    expect(takeMany(secondGuest, "start", 100, 1_000)).toBe(100);
  });

  it("keeps each kind of request in its own bucket", () => {
    const guestId = randomUUID();
    takeMany(guestId, "start", 100, 1_000);
    expect(takeToken(guestId, "start", 1_000).allowed).toBe(false);
    expect(takeToken(guestId, "presign", 1_000).allowed).toBe(true);
  });

  it("never refuses a 60-photo batch's starts and presigns, even all at once and re-picked after a reload", () => {
    const guestId = randomUUID();
    // A 50 MB photo is 7 parts of 8 MB, and one presign fetches up to 20 part URLs.
    const presignsPerPhoto = Math.ceil(Math.ceil((50 * 1024 * 1024) / (8 * 1024 * 1024)) / 20);
    expect(takeMany(guestId, "start", 60, 0)).toBe(60);
    expect(takeMany(guestId, "presign", 60 * presignsPerPhoto, 0)).toBe(60 * presignsPerPhoto);
    // The connection drops; 30 s later the guest re-picks the same 60 photos, which resume.
    expect(takeMany(guestId, "start", 60, 30_000)).toBe(60);
    expect(takeMany(guestId, "presign", 60 * presignsPerPhoto, 30_000)).toBe(60 * presignsPerPhoto);
  });

  it("allows 5 written wishes, then one a minute", () => {
    const guestId = randomUUID();
    expect(takeMany(guestId, "text-wish", 5, 0)).toBe(5);
    expect(takeToken(guestId, "text-wish", 0)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(takeToken(guestId, "text-wish", 30_000)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(takeToken(guestId, "text-wish", 60_000).allowed).toBe(true);
    expect(takeToken(guestId, "text-wish", 60_000).allowed).toBe(false);
  });

  it("allows 20 personal-link opens and 20 guest calls, then one a second", () => {
    for (const bucket of ["link", "guest"] as const) {
      const guestId = randomUUID();
      expect(takeMany(guestId, bucket, 20, 0)).toBe(20);
      expect(takeToken(guestId, bucket, 0)).toEqual({ allowed: false, retryAfterSeconds: 1 });
      expect(takeToken(guestId, bucket, 1_000).allowed).toBe(true);
    }
  });

  it("gives nothing back when the clock goes backwards", () => {
    const guestId = randomUUID();
    takeMany(guestId, "start", 100, 60_000);
    expect(takeToken(guestId, "start", 0).allowed).toBe(false);
  });

  it("holds the numbers the plan sets: 100 then 2 a second, 5 written wishes then 1 a minute, 20 then 1 a second", () => {
    for (const bucket of UPLOAD_BUCKETS) expect(RATE_LIMITS[bucket]).toEqual({ burst: 100, refillEveryMs: 500 });
    expect(RATE_LIMITS["text-wish"]).toEqual({ burst: 5, refillEveryMs: 60_000 });
    expect(RATE_LIMITS.link).toEqual({ burst: 20, refillEveryMs: 1_000 });
    expect(RATE_LIMITS.guest).toEqual({ burst: 20, refillEveryMs: 1_000 });
  });

  it("shares its counts across copies of the module, as Next's several server bundles load it", async () => {
    const guestId = randomUUID();
    takeMany(guestId, "start", 100, 1_000);
    vi.resetModules();
    const otherBundle = await import("./rate-limit");
    expect(otherBundle.takeToken(guestId, "start", 1_000).allowed).toBe(false);
  });
});

describe("the counts stay bounded", () => {
  it("forgets buckets that have refilled once there are too many", () => {
    const limited = randomUUID();
    takeMany(limited, "text-wish", 6, 0);
    for (let guest = 1; guest < MAX_TRACKED_BUCKETS; guest += 1) takeToken(randomUUID(), "start", 0);
    expect(trackedBuckets().size).toBe(MAX_TRACKED_BUCKETS);

    // A second on, every start bucket has its token back: the same as never having been used.
    takeToken(randomUUID(), "start", 1_000);
    expect(trackedBuckets().size).toBe(2);
    expect(takeToken(limited, "text-wish", 1_000).allowed).toBe(false);
  });

  it("forgets the least recently used when a flood of guests keeps them all busy", () => {
    const earliest = randomUUID();
    takeToken(earliest, "start", 0);
    for (let guest = 2; guest < MAX_TRACKED_BUCKETS; guest += 1) takeToken(randomUUID(), "start", 0);
    const limited = randomUUID();
    takeMany(limited, "start", 101, 0);
    expect(trackedBuckets().size).toBe(MAX_TRACKED_BUCKETS);

    takeToken(randomUUID(), "start", 1);
    expect(trackedBuckets().size).toBeLessThanOrEqual(MAX_TRACKED_BUCKETS * 0.8);
    expect(trackedBuckets().has(`start:${earliest}`)).toBe(false);
    expect(takeToken(limited, "start", 1).allowed).toBe(false);
  });
});

describe("rateLimitedResponse", () => {
  it("is a private 429 that says how long to wait", async () => {
    const response = rateLimitedResponse(7);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "rate-limited", retryAfterSeconds: 7 });
  });
});
