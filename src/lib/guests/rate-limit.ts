/**
 * Per-guest abuse caps, keyed by the browser's own guest id and never by IP: carrier NAT and the
 * venue Wi-Fi put many guests behind one address. Each bucket allows a burst, then one more request
 * every `refillEveryMs`. An honest guest never meets them: a 60-photo batch uses 60 starts.
 */
export const RATE_LIMITS = {
  start: { burst: 100, refillEveryMs: 500 },
  presign: { burst: 100, refillEveryMs: 500 },
  events: { burst: 100, refillEveryMs: 500 },
  playable: { burst: 100, refillEveryMs: 500 },
  download: { burst: 100, refillEveryMs: 500 },
  wish: { burst: 100, refillEveryMs: 500 },
  "text-wish": { burst: 5, refillEveryMs: 60_000 },
  link: { burst: 20, refillEveryMs: 1_000 },
  guest: { burst: 20, refillEveryMs: 1_000 },
} as const satisfies Record<string, { burst: number; refillEveryMs: number }>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/** How many guest-and-bucket counts are kept before the idle ones are forgotten. */
export const MAX_TRACKED_BUCKETS = 20_000;

// A clean-up leaves fewer than this, so the next one is thousands of new guests away.
const TRACKED_AFTER_CLEANUP = MAX_TRACKED_BUCKETS * 0.8;

// Next loads this file once per server bundle (instrumentation, pages, route handlers), so module
// state would keep a separate count in each. The globalThis key is shared by every bundle in the
// process, as the database pool's and the job queue's are. The counts live only in memory in the
// one app process, so a restart forgets them, which is fine for abuse caps.
//
// Each entry is `${bucket}:${guestId}` → the moment that bucket is full again (a generic cell rate
// algorithm: one number per bucket, in whole milliseconds, so no rounding creeps in). A bucket
// that is full again is the same as one never used. The Map's order is least recently used first.
const globalWithLimits = globalThis as typeof globalThis & { __nonaRateLimits?: Map<string, number> };

function trackedBuckets(): Map<string, number> {
  globalWithLimits.__nonaRateLimits ??= new Map();
  return globalWithLimits.__nonaRateLimits;
}

function forgetIdle(tracked: Map<string, number>, now: number): void {
  for (const [key, fullAt] of tracked) {
    if (fullAt <= now) tracked.delete(key);
  }
  // Still crowded, by a flood of busy guests: forget the least recently used. That can only let
  // someone through sooner, never hold an honest guest back.
  for (const key of tracked.keys()) {
    if (tracked.size < TRACKED_AFTER_CLEANUP) break;
    tracked.delete(key);
  }
}

/**
 * Takes one request from the guest's bucket. Refused, it says how many seconds to wait, for the
 * 429's Retry-After. `now` is milliseconds on a monotonic clock; tests pass their own.
 */
export function takeToken(guestId: string, bucket: RateLimitBucket, now: number = performance.now()): RateLimitResult {
  const { burst, refillEveryMs } = RATE_LIMITS[bucket];
  const tracked = trackedBuckets();
  const key = `${bucket}:${guestId}`;
  const previous = tracked.get(key);
  if (previous === undefined && tracked.size >= MAX_TRACKED_BUCKETS) forgetIdle(tracked, now);

  const fullAt = Math.max(previous ?? now, now);
  // Delete, then set, to move the key to the end: the most recently used.
  tracked.delete(key);
  // Allowed while at least one request's worth has refilled: fullAt is at most burst - 1 steps away.
  const waitMs = fullAt - now - (burst - 1) * refillEveryMs;
  if (waitMs > 0) {
    tracked.set(key, fullAt);
    return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }
  tracked.set(key, fullAt + refillEveryMs);
  return { allowed: true, retryAfterSeconds: 0 };
}

/** The 429 for a refused request. The uploader waits out Retry-After and tries again, unseen by the guest. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate-limited", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "private, no-store" } },
  );
}
