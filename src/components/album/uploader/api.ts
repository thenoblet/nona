/*
 * The uploader's calls to the site's own API (the guest, the upload routes, the events), each with
 * a timeout. A 429 is waited out, by its Retry-After, and asked again: the guest never sees one. A
 * dropped connection or a server briefly down is tried again a few times, waiting longer each
 * time. Every other answer is returned as it is, for outcomes.ts to read.
 */

export type ApiAnswer = { status: number; body: unknown };

export type ApiErrorKind = "network" | "timeout";

/** A call that never got an answer, after its tries: the uploader carries on later by itself. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiRequest = {
  method: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** How long one try may take. */
  timeoutMs: number;
  /** Ends the call at once, with no further tries (the guest cancelled). */
  signal?: AbortSignal;
  /** Lets the request outlive the page (the events sent as it closes). */
  keepalive?: boolean;
};

export type ApiClient = { request(path: string, request: ApiRequest): Promise<ApiAnswer> };

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

/** The waits before each retry of a dropped call: three more tries, about 11 s in all. */
const RETRY_DELAYS_MILLISECONDS = [1_000, 3_000, 7_000];
/** The most 429s waited out in a row before the answer is returned (an honest guest never meets one). */
const MAX_RATE_LIMIT_WAITS = 30;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

/**
 * The error for a call its caller ended: the signal's reason when it is an error already, else an
 * AbortError carrying the reason as its cause (Uppy pauses a file with a Symbol, and tells a pause
 * from a failure by that cause).
 */
function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  if (reason && typeof reason === "object" && "name" in reason) return reason;
  return Object.assign(new DOMException("The upload was cancelled", "AbortError"), { cause: reason });
}

const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Seconds to wait before asking again: the Retry-After header, else the body's, else one. */
function retryAfterMilliseconds(response: Response, body: unknown): number {
  const header = Number(response.headers.get("Retry-After"));
  const fromBody = Number((body as { retryAfterSeconds?: unknown } | null)?.retryAfterSeconds);
  const seconds = Number.isFinite(header) && header > 0 ? header : Number.isFinite(fromBody) && fromBody > 0 ? fromBody : 1;
  return Math.min(seconds, MAX_RATE_LIMIT_WAIT_SECONDS) * 1000;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type Attempt = { answer: ApiAnswer; response: Response } | { failed: ApiError };

export function createApiClient(options: { fetch?: typeof fetch; sleep?: Sleep } = {}): ApiClient {
  const send = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;

  /** One try, ended by its timeout or the caller's signal. */
  async function attempt(path: string, request: ApiRequest): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await send(path, {
        method: request.method,
        headers: request.body === undefined ? undefined : { "Content-Type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        credentials: "same-origin",
        cache: "no-store",
        keepalive: request.keepalive,
        signal: controller.signal,
      });
      return { answer: { status: response.status, body: await readBody(response) }, response };
    } catch (error) {
      if (request.signal?.aborted) throw abortError(request.signal);
      if (timedOut) return { failed: new ApiError("timeout", `${request.method} ${path} took longer than ${request.timeoutMs} ms`) };
      return { failed: new ApiError("network", error instanceof Error ? error.message : "The request failed") };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }

  return {
    async request(path, request) {
      let retries = 0;
      let rateLimitWaits = 0;
      for (;;) {
        if (request.signal?.aborted) throw abortError(request.signal);
        const result = await attempt(path, request);
        if ("answer" in result) {
          const { answer, response } = result;
          if (answer.status === 429 && rateLimitWaits < MAX_RATE_LIMIT_WAITS) {
            rateLimitWaits += 1;
            await sleep(retryAfterMilliseconds(response, answer.body), request.signal);
            continue;
          }
          if (answer.status >= 500 && retries < RETRY_DELAYS_MILLISECONDS.length) {
            await sleep(RETRY_DELAYS_MILLISECONDS[retries], request.signal);
            retries += 1;
            continue;
          }
          return answer;
        }
        if (retries >= RETRY_DELAYS_MILLISECONDS.length) throw result.failed;
        await sleep(RETRY_DELAYS_MILLISECONDS[retries], request.signal);
        retries += 1;
      }
    },
  };
}
