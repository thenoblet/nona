/**
 * Per-guest abuse caps, keyed by the browser's own guest id and never by IP: carrier NAT and the
 * venue Wi-Fi put many guests behind one address. Each bucket allows a burst, then one more request
 * every `refillEveryMs`. An honest guest never meets them: a 60-photo batch uses 60 starts.
 */
export const RATE_LIMITS = {
  start: { burst: 100, refillEveryMs: 500 },
  presign: { burst: 100, refillEveryMs: 500 },
  // Completing or cancelling an upload: one per file, apart from its start, so a 60-photo batch
  // takes 60 from each bucket and never 120 from one.
  complete: { burst: 100, refillEveryMs: 500 },
  events: { burst: 100, refillEveryMs: 500 },
  playable: { burst: 100, refillEveryMs: 500 },
  // Conversions a guest's phone starts on demand (the first ask for each video): 10, then one a
  // minute, so no one guest can push the whole album onto the on-demand queue (Task 11 review).
  conversion: { burst: 10, refillEveryMs: 60_000 },
  download: { burst: 100, refillEveryMs: 500 },
  // The album's pages and its new-moments check, and one moment's state (the viewer and the
  // uploader ask after a video or photo being made ready).
  album: { burst: 100, refillEveryMs: 500 },
  item: { burst: 100, refillEveryMs: 500 },
  wish: { burst: 100, refillEveryMs: 500 },
  // Written wishes: 20 at once, then one every 10 s, so a phone passed round a table, or a family
  // sharing one, never meets it, while a script can't fill the wall.
  "text-wish": { burst: 20, refillEveryMs: 10_000 },
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
// algorithm: one number per bucket). takeToken floors `now`, so every stored moment is a whole
// millisecond and no rounding creeps in at the limits. A bucket that is full again is the same as
// one never used. The Map's order is least recently used first.
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
 * 429's Retry-After. `now` is milliseconds on a monotonic clock (performance.now(), which has
 * fractions; it is floored); tests pass their own.
 */
export function takeToken(guestId: string, bucket: RateLimitBucket, now: number = performance.now()): RateLimitResult {
  const nowMs = Math.floor(now);
  const { burst, refillEveryMs } = RATE_LIMITS[bucket];
  const tracked = trackedBuckets();
  const key = `${bucket}:${guestId}`;
  const previous = tracked.get(key);
  if (previous === undefined && tracked.size >= MAX_TRACKED_BUCKETS) forgetIdle(tracked, nowMs);

  const fullAt = Math.max(previous ?? nowMs, nowMs);
  // Delete, then set, to move the key to the end: the most recently used.
  tracked.delete(key);
  // Allowed while at least one request's worth has refilled: fullAt is at most burst - 1 steps away.
  const waitMs = fullAt - nowMs - (burst - 1) * refillEveryMs;
  if (waitMs > 0) {
    tracked.set(key, fullAt);
    return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
  }
  tracked.set(key, fullAt + refillEveryMs);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Gives back one request takeToken allowed, when the work it was for failed (a save the database
 * refused), as if it had never been taken; a bucket never fills past full. Synchronous, as
 * takeToken is, so requests running side by side can never take more than the bucket holds: each
 * takes its turn before its work, and only a failed one gives it back.
 */
export function returnToken(guestId: string, bucket: RateLimitBucket, now: number = performance.now()): void {
  const tracked = trackedBuckets();
  const key = `${bucket}:${guestId}`;
  const fullAt = tracked.get(key);
  if (fullAt === undefined) return;
  const givenBack = fullAt - RATE_LIMITS[bucket].refillEveryMs;
  if (givenBack <= Math.floor(now)) tracked.delete(key);
  else tracked.set(key, givenBack);
}

/** The 429 for a refused request. The uploader waits out Retry-After and tries again, unseen by the guest. */
export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "rate-limited", retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds), "Cache-Control": "private, no-store" } },
  );
}
