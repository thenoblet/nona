/*
 * Taking URLs out of Cloudflare's cache: a hidden item's public files are deleted from R2 by the
 * media worker's visibility job, then purged here, so a copy Cloudflare kept can't still be served.
 * Only the worker calls this (third-party calls never run in a request): it imports nothing from
 * next/, and reads its settings when it runs.
 *
 * - CF_PURGE_TOKEN: an API token allowed only "Zone · Cache Purge" on the site's zone.
 * - CF_ZONE_ID: that zone's id.
 * In production both are required, and a purge without them fails, so its job is retried and the
 * failure is seen in the log; outside production a purge without them is skipped. The token is
 * sent only as a bearer header, and never logged or put in an error.
 */

// Not NodeJS.ProcessEnv: Next's typings make NODE_ENV required there.
type Env = Record<string, string | undefined>;

/** Cloudflare's API. */
export const CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4";
/** The most URLs one purge_cache call takes (Cloudflare's limit on every plan). */
export const PURGE_FILES_PER_CALL = 30;
/** How long one purge_cache call may take in all, its answer included. */
export const PURGE_TIMEOUT_MILLISECONDS = 10_000;

// A zone id is 32 hex characters; nothing else may go into the API's path.
const ZONE_ID = /^[0-9a-f]{32}$/i;

export type PurgeOptions = {
  /** Ends the calls early: the job's signal. */
  signal?: AbortSignal;
  /** Where CF_PURGE_TOKEN, CF_ZONE_ID and NODE_ENV come from, when the call runs; process.env by default. */
  env?: Env;
  /** Cloudflare's API, or a test's stand-in for it. */
  apiUrl?: string;
  /** Each call's limit; 10 s unless a test wants it shorter. */
  timeoutMilliseconds?: number;
};

export type PurgeResult =
  /** Every URL was purged, in this many URLs. */
  | { purged: number }
  /** Outside production, with no token or zone set: nothing was sent. */
  | { skipped: "not-configured" };

/** A purge in production with no token or zone set: a deploy's mistake, to be fixed in Dokploy. */
export class PurgeNotConfiguredError extends Error {
  override name = "PurgeNotConfiguredError";
}

type CloudflareAnswer = { success?: unknown; errors?: { code?: unknown; message?: unknown }[] };

/** Cloudflare's errors as "code message; …", from an answer that may not be JSON at all. */
function describeErrors(answer: CloudflareAnswer | null): string {
  const errors = Array.isArray(answer?.errors) ? answer.errors : [];
  const described = errors.map((error) => `${String(error.code ?? "")} ${String(error.message ?? "")}`.trim());
  return described.length > 0 ? described.join("; ") : "no error given";
}

/** One purge_cache call for up to 30 URLs. Throws unless Cloudflare answers success. */
async function purgeBatch(files: string[], zoneId: string, token: string, options: PurgeOptions): Promise<void> {
  const timeout = AbortSignal.timeout(options.timeoutMilliseconds ?? PURGE_TIMEOUT_MILLISECONDS);
  const response = await fetch(`${options.apiUrl ?? CLOUDFLARE_API_URL}/zones/${zoneId}/purge_cache`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  // The timeout covers reading the answer too.
  const text = await response.text();
  let answer: CloudflareAnswer | null = null;
  try {
    answer = JSON.parse(text) as CloudflareAnswer;
  } catch {
    // Not JSON (a proxy's error page): described as giving no error.
  }
  if (!response.ok || answer?.success !== true) {
    throw new Error(`Cloudflare refused to purge ${files.length} URL(s): ${response.status} ${describeErrors(answer)}`);
  }
}

/**
 * Purges these URLs (full URLs under MEDIA_BASE_URL, as the files were served) from Cloudflare's
 * cache: POST /zones/<CF_ZONE_ID>/purge_cache with `{ files }`, 30 URLs a call, one call at a time,
 * each within 10 s. Throws at the first call that fails (a timeout, a refusal, a rate limit), so
 * the job retries them all: purging a URL twice is harmless. In production without CF_PURGE_TOKEN
 * or CF_ZONE_ID it throws PurgeNotConfiguredError; outside production it skips.
 */
export async function purgeUrls(urls: string[], options: PurgeOptions = {}): Promise<PurgeResult> {
  if (urls.length === 0) return { purged: 0 };
  const env = options.env ?? process.env;
  const token = env.CF_PURGE_TOKEN?.trim();
  const zoneId = env.CF_ZONE_ID?.trim();
  if (!token || !zoneId) {
    if (env.NODE_ENV === "production") {
      throw new PurgeNotConfiguredError(
        "CF_PURGE_TOKEN and CF_ZONE_ID must be set in production: hidden files can't be purged from Cloudflare's cache without them",
      );
    }
    return { skipped: "not-configured" };
  }
  if (!ZONE_ID.test(zoneId)) throw new Error("CF_ZONE_ID is not a zone id (32 hex characters)");
  for (let start = 0; start < urls.length; start += PURGE_FILES_PER_CALL) {
    await purgeBatch(urls.slice(start, start + PURGE_FILES_PER_CALL), zoneId, token, options);
  }
  return { purged: urls.length };
}
