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
import { cutOffWhenIdle, storageClient } from "./client";

// Originals live in the private bucket and are reached only through presigned links. Derived files
// live in the public one. Presigning is local (no network), so it needs no timeout.

/** A presigned part URL lasts an hour; the phone asks again on a 403. */
export const PART_URL_SECONDS = 3600;
/** The most part URLs one presign hands out. */
export const MAX_PARTS_PER_PRESIGN = 20;
// S3's limits: part numbers run from 1 to 10,000, and a presigned link lasts at most 7 days.
const MAX_PART_NUMBER = 10_000;
const MAX_LINK_SECONDS = 7 * 24 * 3600;
// Derived files sit under a content hash, so a key's bytes never change.
const PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";
// An original's download that sends nothing for this long is cut off.
const DOWNLOAD_IDLE_MILLISECONDS = 10_000;
// S3 lower-cases metadata names, so only lower-case names read back as they were written.
const METADATA_NAME = /^[a-z0-9][a-z0-9-]*$/;

export type PartUrl = { partNumber: number; url: string };
export type UploadedPart = { partNumber: number; etag: string; size: number };
export type CompletedPart = { partNumber: number; etag: string };
export type OriginalHead = {
  size: number;
  contentType: string | undefined;
  etag: string;
  lastModified: Date | undefined;
  metadata: Record<string, string>;
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
 * the phone's part PUTs carry no headers, and an original is never rewritten. Each metadata value
 * is URI-encoded, since S3 metadata travels as ASCII headers; headOriginal decodes it.
 * Returns the upload id.
 */
export async function startMultipart(
  key: string,
  contentType: string,
  metadata: Record<string, string>,
): Promise<string> {
  const encoded: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata)) {
    if (!METADATA_NAME.test(name)) {
      throw new Error(
        `Refusing ${JSON.stringify(name)} as a metadata name: use lower-case letters, digits and -`,
      );
    }
    encoded[name] = encodeURIComponent(value.toWellFormed());
  }
  const started = await storageClient().send(
    new CreateMultipartUploadCommand({
      Bucket: privateBucket(),
      Key: key,
      ContentType: contentType,
      Metadata: encoded,
    }),
  );
  if (!started.UploadId) throw new Error("Starting the multipart upload returned no upload id");
  return started.UploadId;
}

/** Presigned PUT URLs for up to 20 parts, each valid for an hour. */
export async function presignParts(key: string, uploadId: string, partNumbers: number[]): Promise<PartUrl[]> {
  if (partNumbers.length === 0 || partNumbers.length > MAX_PARTS_PER_PRESIGN) {
    throw new RangeError(
      `Presign between 1 and ${MAX_PARTS_PER_PRESIGN} parts at a time, not ${partNumbers.length}`,
    );
  }
  for (const partNumber of partNumbers) {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PART_NUMBER) {
      throw new RangeError(`Refusing ${partNumber} as a part number: parts run from 1 to ${MAX_PART_NUMBER}`);
    }
  }
  const client = storageClient();
  const bucket = privateBucket();
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: PART_URL_SECONDS },
      ),
    })),
  );
}

/** The parts R2 already holds for an upload, in order. Throws NoSuchUpload once it is completed or aborted. */
export async function listUploadedParts(key: string, uploadId: string): Promise<UploadedPart[]> {
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
): Promise<void> {
  const ordered = [...parts].sort((first, second) => first.partNumber - second.partNumber);
  await storageClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: privateBucket(),
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
    }),
  );
}

/** Drops an unfinished upload and its parts. An upload that is already gone counts as aborted. */
export async function abortMultipart(key: string, uploadId: string): Promise<void> {
  try {
    await storageClient().send(
      new AbortMultipartUploadCommand({ Bucket: privateBucket(), Key: key, UploadId: uploadId }),
    );
  } catch (error) {
    if (errorName(error) !== "NoSuchUpload") throw error;
  }
}

function decodeMetadataValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Not written by startMultipart: keep it as it is.
    return value;
  }
}

/** The original's size, type, ETag and decoded metadata, or null when there is no such original. */
export async function headOriginal(key: string): Promise<OriginalHead | null> {
  try {
    const head = await storageClient().send(new HeadObjectCommand({ Bucket: privateBucket(), Key: key }));
    const metadata: Record<string, string> = {};
    for (const [name, value] of Object.entries(head.Metadata ?? {})) {
      metadata[name] = decodeMetadataValue(value);
    }
    return {
      size: head.ContentLength ?? 0,
      contentType: head.ContentType,
      etag: head.ETag ?? "",
      lastModified: head.LastModified,
      metadata,
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
 * A presigned GET for a private object (an original or a zip). With a filename, the browser
 * downloads it under that name; without one, it can play in the page.
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
      Key: key,
      ResponseContentDisposition: filename === undefined ? undefined : attachment(filename),
    }),
    { expiresIn: expiresInSeconds },
  );
}

/**
 * Writes a derived file to the public bucket, cached for good. The body may be bytes or a stream
 * of unknown length; a large one goes up in parts, each part's request under the client's timeouts.
 */
export async function putPublicObject(
  key: string,
  body: Uint8Array | string | Readable,
  contentType: string,
): Promise<void> {
  await new Upload({
    client: storageClient(),
    params: {
      Bucket: publicBucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: PUBLIC_CACHE_CONTROL,
    },
  }).done();
}

/** Deletes derived files from the public bucket. A key that is already gone is not an error. */
export async function deletePublicObjects(keys: string[]): Promise<void> {
  // DeleteObjects takes at most 1,000 keys a call.
  for (let start = 0; start < keys.length; start += 1000) {
    const batch = keys.slice(start, start + 1000);
    const result = await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: publicBucket(),
        Delete: { Objects: batch.map((key) => ({ Key: key })), Quiet: true },
      }),
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
 * stalls for 10 s ends with a TimeoutError, so read it promptly.
 */
export async function readOriginalStream(key: string): Promise<Readable> {
  const response = await storageClient().send(new GetObjectCommand({ Bucket: privateBucket(), Key: key }));
  if (!(response.Body instanceof IncomingMessage)) {
    throw new Error("Expected the original's body as a Node stream");
  }
  return cutOffWhenIdle(response.Body, DOWNLOAD_IDLE_MILLISECONDS);
}
