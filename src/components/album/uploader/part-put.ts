/*
 * One part's PUT to its presigned URL, done here rather than by @uppy/aws-s3's own uploadPartBytes.
 * Uppy 5.1.0's never settles when the browser can't read the response's ETag (a bucket whose CORS
 * doesn't expose it): it returns without resolving, its abort listener already gone, and the part
 * hangs for good. Here a 2xx always resolves, with the ETag when it can be read and "" when it
 * can't: the server's complete joins the parts from R2's own list, not the phone's ETags.
 *
 * A PUT with no progress for a minute is dropped and rejected as a dropped connection (status 0),
 * so Uppy sends the part again. Uppy's own semantics are kept otherwise: an expired link's 403 says
 * "Request has expired" (Uppy signs it again), any other answer outside 2xx rejects with its status
 * on `source`, and the caller's abort (a pause, or Cancel) rejects as an AbortError carrying the
 * signal's reason as its cause.
 */

export type PartPutRequest = {
  signature: { url: string; method?: string; headers?: Record<string, string> };
  body: Blob | FormData;
  size?: number;
  onProgress?: (event: { loaded: number; lengthComputable: boolean }) => void;
  onComplete?: (etag: string) => void;
  signal?: AbortSignal;
};

export type PartPutResult = { ETag: string };

export type PartPut = (request: PartPutRequest) => Promise<PartPutResult>;

/** The parts of XMLHttpRequest a PUT uses, so a test can stand in for it. */
export type PartRequest = {
  open(method: string, url: string, async: boolean): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob | FormData): void;
  abort(): void;
  getResponseHeader(name: string): string | null;
  readonly status: number;
  readonly responseText: string;
  responseType: XMLHttpRequestResponseType;
  addEventListener(type: "load" | "error" | "abort", listener: () => void): void;
  readonly upload: { addEventListener(type: "progress", listener: (event: ProgressEvent) => void): void };
};

/** A part that had no progress for a minute (or `stallMs`). */
export const PART_STALL_MILLISECONDS = 60_000;

/** An error Uppy reads: its `source.status` says whether (and how) to try the part again. */
function partError(message: string, status: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { source: { status }, ...extra });
}

function abortError(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return Object.assign(new DOMException("The part was stopped", "AbortError"), { cause: reason });
}

export function createPartPut(
  options: { createRequest?: () => PartRequest; stallMs?: number } = {},
): PartPut {
  const createRequest = options.createRequest ?? (() => new XMLHttpRequest() as unknown as PartRequest);
  const stallMs = options.stallMs ?? PART_STALL_MILLISECONDS;

  return (request) =>
    new Promise<PartPutResult>((resolve, reject) => {
      const { signal } = request;
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const size = request.size ?? (request.body instanceof Blob ? request.body.size : 0);
      const xhr = createRequest();
      let settled = false;
      let stallTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(stallTimer);
        signal?.removeEventListener("abort", onAbort);
        outcome();
      };
      const watchForStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          settle(() => reject(partError("The part stalled", 0, { stalled: true })));
          xhr.abort();
        }, stallMs);
      };
      function onAbort() {
        settle(() => reject(abortError(signal as AbortSignal)));
        xhr.abort();
      }

      xhr.open(request.signature.method ?? "PUT", request.signature.url, true);
      for (const [name, value] of Object.entries(request.signature.headers ?? {})) xhr.setRequestHeader(name, value);
      xhr.responseType = "text";
      xhr.upload.addEventListener("progress", (event) => {
        watchForStall();
        if (event.lengthComputable) request.onProgress?.(event);
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          const etag = xhr.getResponseHeader("ETag") ?? "";
          settle(() => {
            request.onProgress?.({ loaded: size, lengthComputable: true });
            request.onComplete?.(etag);
            resolve({ ETag: etag });
          });
          return;
        }
        const expired = xhr.status === 403 && xhr.responseText.includes("<Message>Request has expired</Message>");
        settle(() => reject(partError(expired ? "Request has expired" : "Non 2xx", xhr.status)));
      });
      xhr.addEventListener("error", () => settle(() => reject(partError("The connection dropped", 0))));
      xhr.addEventListener("abort", () => settle(() => reject(signal?.aborted ? abortError(signal) : partError("The part was dropped", 0))));
      signal?.addEventListener("abort", onAbort, { once: true });
      watchForStall();
      xhr.send(request.body);
    });
}
