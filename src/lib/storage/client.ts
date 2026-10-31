import type { IncomingMessage } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { storageConfig, type StorageConfig } from "@/lib/env";

/**
 * An S3 client for R2 (MinIO locally).
 * - Each attempt: connecting is cut off after 5 s, and an attempt whose answer hasn't begun 10 s
 *   after it started (sending its body included). The SDK only logs a breached requestTimeout
 *   unless throwOnRequestTimeout is set, so it is. That timeout stops once the answer's headers
 *   arrive, so it doesn't cover the body: withDeadline (a whole call) and cutOffWhenIdle (a
 *   download) do.
 * - Two attempts in all, so a call against a silent R2 gives up after about 20 s, or at its 15 s
 *   deadline, whichever comes first.
 * - Path-style addresses (endpoint/bucket/key), which both MinIO and R2 accept.
 * - Checksums only where S3 requires them: a presigned part URL then carries no checksum
 *   parameter, so the phone's PUT needs nothing but the bytes.
 */
export function createStorageClient(config: StorageConfig): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    maxAttempts: 2,
    requestHandler: {
      connectionTimeout: 5_000,
      requestTimeout: 10_000,
      throwOnRequestTimeout: true,
    },
  });
}

// Next loads this file once per server bundle, so a module variable would make several clients.
// The globalThis key is shared by every bundle in the process, as the database's is.
const globalWithStorage = globalThis as typeof globalThis & { __nonaStorage?: S3Client };

/** One client per process, made on first use from the R2_* settings. */
export function storageClient(): S3Client {
  globalWithStorage.__nonaStorage ??= createStorageClient(storageConfig());
  return globalWithStorage.__nonaStorage;
}

/** How long a storage call that isn't a stream may take in all, by default. */
export const CALL_DEADLINE_MILLISECONDS = 15_000;

/** Every storage call takes an optional signal; aborting it ends the call. */
export type CallOptions = { signal?: AbortSignal };

/**
 * The send options for a call that isn't a stream: a 15 s deadline for the whole call, covering
 * the answer's headers and body and the retry, combined with the caller's signal when there is
 * one (Ruling K). The call ends at whichever comes first, so passing request.signal (which may
 * never fire) keeps the bound, and a route can pass one shorter signal to share a single budget
 * between several calls.
 */
export function withDeadline(options: CallOptions = {}): { abortSignal: AbortSignal } {
  const deadline = AbortSignal.timeout(CALL_DEADLINE_MILLISECONDS);
  return { abortSignal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline };
}

/**
 * Ends a download that sends nothing for `idleMilliseconds` with a TimeoutError. The request
 * timeout stops once the response starts, so without this a body that stalls part-way would hang
 * its reader for good. Read it promptly: a reader that stops pulling looks idle too.
 */
export function cutOffWhenIdle(download: IncomingMessage, idleMilliseconds: number): IncomingMessage {
  return download.setTimeout(idleMilliseconds, () => {
    download.destroy(
      Object.assign(new Error(`The download sent nothing for ${idleMilliseconds} ms`), {
        name: "TimeoutError",
      }),
    );
  });
}
