import type { IncomingMessage } from "node:http";
import { S3Client } from "@aws-sdk/client-s3";
import { storageConfig, type StorageConfig } from "@/lib/env";

/**
 * An S3 client for R2 (MinIO locally).
 * - Connecting is cut off after 5 s, and a request whose answer hasn't begun 10 s after it started
 *   (sending its body included). The SDK only logs a breached requestTimeout unless
 *   throwOnRequestTimeout is set, so it is. It retries a timed-out request (three attempts in all).
 *   A response body that stalls later is cut off by cutOffWhenIdle.
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
