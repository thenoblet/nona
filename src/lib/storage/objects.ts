import "server-only";
import { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { storageConfig } from "@/lib/env";
import { cutOffWhenIdle, storageClient, withDeadline, type CallOptions } from "./client";
import { assertDerivedKey, assertOriginalKey } from "./keys";
import { decodeOriginalMetadata, encodeOriginalMetadata, type OriginalMetadata } from "./metadata";

// Originals live in the private bucket and are reached only through presigned links. Derived files
// live in the public one. Presigning is local (no network), so it needs no timeout.
//
// Every call that isn't a stream takes { signal } and, without one, gives up after 15 s in all
// (withDeadline). The two streams, readOriginalStream and putPublicObject, have no overall
// deadline, since a converted video can be large: each request keeps its own timeouts, a stalled
// download is cut off, and a caller's signal (the worker's job) ends them.

/** A presigned part URL lasts an hour; the phone asks again on a 403. */
export const PART_URL_SECONDS = 3600;
/** A presigned link to play a video lasts 2 hours. */
export const PLAYBACK_URL_SECONDS = 2 * 3600;
/** A presigned download link lasts 6 hours. */
export const DOWNLOAD_URL_SECONDS = 6 * 3600;
/** The most part URLs one presign hands out. */
export const MAX_PARTS_PER_PRESIGN = 20;
// S3's limits: part numbers run from 1 to 10,000, a part holds at most 5 GiB, and a presigned
// link lasts at most 7 days.
const MAX_PART_NUMBER = 10_000;
const MAX_PART_BYTES = 5 * 1024 ** 3;
const MAX_LINK_SECONDS = 7 * 24 * 3600;
// Derived files sit under a content hash, so a key's bytes never change.
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
// An original's download that sends nothing for this long is cut off.
const DOWNLOAD_IDLE_MILLISECONDS = 10_000;

export type PartUrl = { partNumber: number; url: string };
/** A part to presign: its number and its exact size in bytes, which its URL binds. */
export type PartToSign = { partNumber: number; size: number };
export type UploadedPart = { partNumber: number; etag: string; size: number };
export type CompletedPart = { partNumber: number; etag: string };
export type OriginalHead = {
  size: number;
  contentType: string | undefined;
  etag: string;
  lastModified: Date | undefined;
  /** Null when the original wasn't started by startMultipart. */
  metadata: OriginalMetadata | null;
};

function privateBucket(): string {
  return storageConfig().privateBucket;
}

function publicBucket(): string {
  return storageConfig().publicBucket;
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/**
 * Starts the multipart upload of an original. Its content type and metadata are set here, once:
 * the phone's part PUTs carry no headers, and an original is never rewritten. A long name or
 * filename is shortened to fit S3's metadata limit (see fitOriginalMetadata). Returns the upload id.
 */
export async function startMultipart(
  key: string,
  contentType: string,
  metadata: OriginalMetadata,
  options?: CallOptions,
): Promise<string> {
  const started = await storageClient().send(
    new CreateMultipartUploadCommand({
      Bucket: privateBucket(),
      Key: assertOriginalKey(key),
      ContentType: contentType,
      Metadata: encodeOriginalMetadata(metadata),
    }),
    withDeadline(options),
  );
  if (!started.UploadId) throw new Error("Starting the multipart upload returned no upload id");
  return started.UploadId;
}

// Signed into every part URL, so R2 refuses a PUT of any other length (SignatureDoesNotMatch).
// The presigner signs it already once ContentLength is set; naming it keeps that if it changes.
const SIGNED_PART_HEADERS = new Set(["content-length"]);

/**
 * Presigned PUT URLs for up to 20 parts, each valid for an hour and bound to its part's exact size:
 * Content-Length is signed, so a PUT of more (or fewer) bytes is refused and a client can't store
 * more than the upload declared. The browser sets Content-Length itself from the slice it sends.
 */
export async function presignParts(key: string, uploadId: string, parts: PartToSign[]): Promise<PartUrl[]> {
  assertOriginalKey(key);
  if (parts.length === 0 || parts.length > MAX_PARTS_PER_PRESIGN) {
    throw new RangeError(`Presign between 1 and ${MAX_PARTS_PER_PRESIGN} parts at a time, not ${parts.length}`);
  }
  for (const { partNumber, size } of parts) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw new RangeError(`Refusing ${partNumber} as a part number: parts run from 1 to ${MAX_PART_NUMBER}`);
    }
    if (!Number.isInteger(size) || size < 1 || size > MAX_PART_BYTES) {
      throw new RangeError(`Refusing ${size} as a part's size: a part holds 1 byte to 5 GiB`);
    }
  }
  const client = storageClient();
  const bucket = privateBucket();
  return Promise.all(
    parts.map(async ({ partNumber, size }) => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          ContentLength: size,
        }),
        { expiresIn: PART_URL_SECONDS, signableHeaders: SIGNED_PART_HEADERS },
      ),
    })),
  );
}

/** The parts R2 already holds for an upload, in order. Throws NoSuchUpload once it is completed or aborted. */
export async function listUploadedParts(
  key: string,
  uploadId: string,
  options?: CallOptions,
): Promise<UploadedPart[]> {
  assertOriginalKey(key);
  // One deadline for every page.
  const deadline = withDeadline(options);
  const parts: UploadedPart[] = [];
  let partNumberMarker: string | undefined;
  do {
    const page = await storageClient().send(
      new ListPartsCommand({
        Bucket: privateBucket(),
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: partNumberMarker,
      }),
      deadline,
    );
    for (const part of page.Parts ?? []) {
      parts.push({ partNumber: part.PartNumber ?? 0, etag: part.ETag ?? "", size: part.Size ?? 0 });
    }
    partNumberMarker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (partNumberMarker);
  return parts.sort((first, second) => first.partNumber - second.partNumber);
}

/** Joins the parts into the original. The parts may come in any order. */
export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: CompletedPart[],
  options?: CallOptions,
): Promise<void> {
  const ordered = [...parts].sort((first, second) => first.partNumber - second.partNumber);
  await storageClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: privateBucket(),
      Key: assertOriginalKey(key),
      UploadId: uploadId,
      MultipartUpload: { Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
    withDeadline(options),
  );
}

/** Drops an unfinished upload and its parts. An upload that is already gone counts as aborted. */
export async function abortMultipart(key: string, uploadId: string, options?: CallOptions): Promise<void> {
  try {
    await storageClient().send(
      new AbortMultipartUploadCommand({
        Bucket: privateBucket(),
        Key: assertOriginalKey(key),
        UploadId: uploadId,
      }),
      withDeadline(options),
    );
  } catch (error) {
    if (errorName(error) !== "NoSuchUpload") throw error;
  }
}

/** The original's size, type, ETag and metadata, or null when there is no such original. */
export async function headOriginal(key: string, options?: CallOptions): Promise<OriginalHead | null> {
  try {
    const head = await storageClient().send(
      new HeadObjectCommand({ Bucket: privateBucket(), Key: assertOriginalKey(key) }),
      withDeadline(options),
    );
    return {
      size: head.ContentLength ?? 0,
      contentType: head.ContentType,
      etag: head.ETag ?? "",
      lastModified: head.LastModified,
      metadata: decodeOriginalMetadata(head.Metadata ?? {}),
    };
  } catch (error) {
    if (errorName(error) === "NotFound" || errorName(error) === "NoSuchKey") return null;
    throw error;
  }
}

/** An attachment header that keeps any filename (RFC 6266), with a plain-ASCII fallback for old browsers. */
function attachment(filename: string): string {
  const wellFormed = filename.toWellFormed();
  const fallback = wellFormed.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * A presigned GET for an original (PLAYBACK_URL_SECONDS to play, DOWNLOAD_URL_SECONDS to
 * download). With a filename, the browser downloads it under that name; without one, it can play
 * in the page.
 */
export async function presignGet(
  key: string,
  options: { filename?: string; expiresInSeconds: number },
): Promise<string> {
  const { filename, expiresInSeconds } = options;
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > MAX_LINK_SECONDS) {
    throw new RangeError(
      `expiresInSeconds must be a whole number from 1 to ${MAX_LINK_SECONDS}, not ${expiresInSeconds}`,
    );
  }
  return getSignedUrl(
    storageClient(),
    new GetObjectCommand({
      Bucket: privateBucket(),
      Key: assertOriginalKey(key),
      ResponseContentDisposition: filename === undefined ? undefined : attachment(filename),
    }),
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Writes a derived file to the public bucket, cached for good. The body may be bytes or a stream
 * of unknown length; a large one goes up in 5 MiB parts, four at a time, each part's request under
 * the client's timeouts. There is no overall deadline: pass a signal (the job's) to end it.
 */
export async function putPublicObject(
  key: string,
  body: Uint8Array | string | Readable,
  contentType: string,
  options: CallOptions = {},
): Promise<void> {
  assertDerivedKey(key);
  const abortController = new AbortController();
  const { signal } = options;
  const forwardAbort = () => abortController.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    await new Upload({
      client: storageClient(),
      abortController,
      params: {
        Bucket: publicBucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: PUBLIC_CACHE_CONTROL,
      },
    }).done();
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
}

/** Deletes derived files from the public bucket. A key that is already gone is not an error. */
export async function deletePublicObjects(keys: string[], options?: CallOptions): Promise<void> {
  for (const key of keys) assertDerivedKey(key);
  // One deadline for every batch.
  const deadline = withDeadline(options);
  // DeleteObjects takes at most 1,000 keys a call.
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000);
    const result = await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: publicBucket(),
        Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
      }),
      deadline,
    );
    const failures = result.Errors ?? [];
    if (failures.length > 0) {
      const [first] = failures;
      throw new Error(
        `Could not delete ${failures.length} public object(s), the first ${first.Key}: ${first.Code} ${first.Message}`,
      );
    }
  }
}

/**
 * The original's bytes as a stream, for the worker to copy to its scratch space. A download that
 * sends nothing for 10 s ends with a TimeoutError, so read it promptly. There is no overall
 * deadline, since an original can be 2 GB: pass a signal (the job's) to end it.
 */
export async function readOriginalStream(key: string, options: CallOptions = {}): Promise<Readable> {
  const response = await storageClient().send(
    new GetObjectCommand({ Bucket: privateBucket(), Key: assertOriginalKey(key) }),
    options.signal ? { abortSignal: options.signal } : {},
  );
  if (!(response.Body instanceof IncomingMessage)) {
    throw new Error("Expected the original's body as a Node stream");
  }
  return cutOffWhenIdle(response.Body, DOWNLOAD_IDLE_MILLISECONDS);
}
