import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { storageClient } from "./client";
import { derivedKey, originalKey, publicUrl } from "./keys";
import {
  abortMultipart,
  completeMultipart,
  deletePublicObjects,
  headOriginal,
  listUploadedParts,
  presignGet,
  presignParts,
  putPublicObject,
  readOriginalStream,
  startMultipart,
} from "./objects";

// These run against the local MinIO: docker compose up -d minio && npm run storage:init.

const SITE_ORIGIN = "https://nobletxnancy.com";
// S3's smallest part size, for every part but the last.
const FIVE_MEBIBYTES = 5 * 1024 * 1024;

// Originals this file creates, removed afterwards so the local MinIO doesn't fill with test files.
const createdOriginals: string[] = [];

afterAll(async () => {
  const { privateBucket } = storageConfig();
  await Promise.all(
    createdOriginals.map((key) =>
      storageClient().send(new DeleteObjectCommand({ Bucket: privateBucket, Key: key })),
    ),
  );
});

function newOriginalKey(extension = "jpg"): string {
  const key = originalKey(randomUUID(), extension);
  createdOriginals.push(key);
  return key;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Whether a page on SITE_ORIGIN may read this response header, by the CORS rules browsers enforce. */
function browserCanRead(response: Response, header: string): boolean {
  const allowedOrigin = response.headers.get("access-control-allow-origin");
  if (allowedOrigin !== "*" && allowedOrigin !== SITE_ORIGIN) return false;
  const exposed = (response.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  return exposed.includes(header.toLowerCase());
}

/**
 * PUTs one part the way the phone does: a cross-origin PUT, so the browser asks first (preflight),
 * then sends the bytes with no headers of its own and reads the ETag from the response.
 */
async function putPartFromBrowser(url: string, bytes: Buffer): Promise<string> {
  const preflight = await fetch(url, {
    method: "OPTIONS",
    headers: { Origin: SITE_ORIGIN, "Access-Control-Request-Method": "PUT" },
  });
  expect(preflight.ok).toBe(true);
  expect([SITE_ORIGIN, "*"]).toContain(preflight.headers.get("access-control-allow-origin"));
  expect(preflight.headers.get("access-control-allow-methods")?.toUpperCase()).toContain("PUT");

  // A Blob with no type, as a slice of the picked file is.
  const response = await fetch(url, {
    method: "PUT",
    body: new Blob([new Uint8Array(bytes)]),
    headers: { Origin: SITE_ORIGIN },
  });
  expect(response.status).toBe(200);
  expect(browserCanRead(response, "ETag")).toBe(true);
  const etag = response.headers.get("etag");
  if (!etag) throw new Error("The part's PUT returned no ETag");
  return etag;
}

/** Uploads a whole small file as a one-part multipart upload, as every upload is. */
async function uploadWhole(
  key: string,
  contentType: string,
  metadata: Record<string, string>,
  bytes: Buffer,
) {
  const uploadId = await startMultipart(key, contentType, metadata);
  const [part] = await presignParts(key, uploadId, [1]);
  const etag = await putPartFromBrowser(part.url, bytes);
  await completeMultipart(key, uploadId, [{ partNumber: 1, etag }]);
}

describe("a multipart upload", () => {
  it("round-trips parts PUT from the browser, with each ETag read from its PUT", async () => {
    const key = newOriginalKey("mp4");
    const firstPart = randomBytes(FIVE_MEBIBYTES);
    const lastPart = randomBytes(1000);

    const uploadId = await startMultipart(key, "video/mp4", {});
    const urls = await presignParts(key, uploadId, [1, 2]);
    expect(urls.map((entry) => entry.partNumber)).toEqual([1, 2]);
    const firstEtag = await putPartFromBrowser(urls[0].url, firstPart);
    const lastEtag = await putPartFromBrowser(urls[1].url, lastPart);

    expect(await listUploadedParts(key, uploadId)).toEqual([
      { partNumber: 1, etag: firstEtag, size: FIVE_MEBIBYTES },
      { partNumber: 2, etag: lastEtag, size: 1000 },
    ]);

    // Out of order on purpose: S3 wants them ascending, and completeMultipart sorts them.
    await completeMultipart(key, uploadId, [
      { partNumber: 2, etag: lastEtag },
      { partNumber: 1, etag: firstEtag },
    ]);

    const stored = await readAll(await readOriginalStream(key));
    expect(stored.length).toBe(FIVE_MEBIBYTES + 1000);
    expect(sha256(stored)).toBe(sha256(Buffer.concat([firstPart, lastPart])));
    expect(await headOriginal(key)).toMatchObject({ size: FIVE_MEBIBYTES + 1000, contentType: "video/mp4" });
  }, 30_000);

  it("presigns at most 20 parts at a time, each for an hour, signed for the host alone", async () => {
    const key = newOriginalKey();
    const uploadId = await startMultipart(key, "image/jpeg", {});
    const partNumbers = Array.from({ length: 20 }, (_value, index) => index + 1);

    const urls = await presignParts(key, uploadId, partNumbers);
    expect(urls.map((entry) => entry.partNumber)).toEqual(partNumbers);
    for (const { partNumber, url } of urls) {
      const query = new URL(url).searchParams;
      expect(query.get("partNumber")).toBe(String(partNumber));
      expect(query.get("uploadId")).toBe(uploadId);
      expect(query.get("X-Amz-Expires")).toBe("3600");
      // The browser sends no headers of its own, and no checksum.
      expect(query.get("X-Amz-SignedHeaders")).toBe("host");
      expect([...query.keys()].filter((name) => name.toLowerCase().includes("checksum"))).toEqual([]);
    }

    await expect(presignParts(key, uploadId, [...partNumbers, 21])).rejects.toThrow("20");
    await expect(presignParts(key, uploadId, [])).rejects.toThrow("part");
    for (const partNumber of [0, 10_001, 1.5, Number.NaN]) {
      await expect(presignParts(key, uploadId, [partNumber])).rejects.toThrow("part");
    }
    await abortMultipart(key, uploadId);
  });

  it("aborts, and aborting again is fine", async () => {
    const key = newOriginalKey();
    const uploadId = await startMultipart(key, "image/jpeg", {});
    await abortMultipart(key, uploadId);
    await expect(listUploadedParts(key, uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });
    await expect(abortMultipart(key, uploadId)).resolves.toBeUndefined();
  });
});

describe("headOriginal", () => {
  it("reads back the original's metadata, with names and filenames in any script", async () => {
    const key = newOriginalKey("heic");
    const metadata = {
      "guest-id": randomUUID(),
      "uploader-name": "Ama Ɔdɔ & Kwame 😊",
      "original-filename": "IMG_0001 (copy) 100% é.HEIC",
      "started-at": "2026-12-05T15:04:05.000Z",
    };
    await uploadWhole(key, "image/heic", metadata, randomBytes(2048));

    expect(await headOriginal(key)).toEqual({
      size: 2048,
      contentType: "image/heic",
      etag: expect.stringMatching(/^".+"$/),
      lastModified: expect.any(Date),
      metadata,
    });
  });

  it("is null when there is no such original", async () => {
    expect(await headOriginal(originalKey(randomUUID(), "jpg"))).toBeNull();
  });

  it("refuses a metadata name that S3 would lower-case or mangle", async () => {
    for (const name of ["guestId", "guest id", "", "gäst"]) {
      await expect(startMultipart(newOriginalKey(), "image/jpeg", { [name]: "value" })).rejects.toThrow(
        "metadata",
      );
    }
  });
});

describe("presignGet", () => {
  const bytes = randomBytes(512);
  const key = newOriginalKey();

  beforeAll(() => uploadWhole(key, "image/jpeg", {}, bytes));

  it("names the download with the filename it is given", async () => {
    const url = await presignGet(key, {
      filename: "NONA26-reception-ab12cd.jpg",
      expiresInSeconds: 6 * 3600,
    });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("21600");

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="NONA26-reception-ab12cd.jpg"; filename*=UTF-8''NONA26-reception-ab12cd.jpg`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("keeps a filename in any script, with a plain fallback for old browsers", async () => {
    const url = await presignGet(key, { filename: 'Ɔdɔ\'s "best" (1).jpg', expiresInSeconds: 60 });
    const response = await fetch(url);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="_d_'s _best_ (1).jpg"; filename*=UTF-8''%C6%86d%C9%94%27s%20%22best%22%20%281%29.jpg`,
    );
  });

  it("leaves a link without a filename to play in the page", async () => {
    const url = await presignGet(key, { expiresInSeconds: 2 * 3600 });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("7200");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBeNull();
  });

  it("refuses a lifetime outside one second to seven days", async () => {
    for (const expiresInSeconds of [0, -1, 1.5, 7 * 24 * 3600 + 1]) {
      await expect(presignGet(key, { expiresInSeconds })).rejects.toThrow("expiresInSeconds");
    }
  });
});

describe("public objects", () => {
  it("are served to anyone from MEDIA_BASE_URL, cached for good, until they are deleted", async () => {
    const mediaId = randomUUID();
    const thumbKey = derivedKey(mediaId, "content-hash", "thumb", "webp");
    const videoKey = derivedKey(mediaId, "content-hash", "video", "mp4");
    const neverWritten = derivedKey(mediaId, "content-hash", "card", "jpg");
    const thumbBytes = randomBytes(1024);
    // More than one part, from a stream of unknown length, as a converted video comes.
    const videoBytes = randomBytes(FIVE_MEBIBYTES + 1234);

    await putPublicObject(thumbKey, thumbBytes, "image/webp");
    await putPublicObject(
      videoKey,
      Readable.from([videoBytes.subarray(0, 100_000), videoBytes.subarray(100_000)]),
      "video/mp4",
    );

    for (const [key, bytes, contentType] of [
      [thumbKey, thumbBytes, "image/webp"],
      [videoKey, videoBytes, "video/mp4"],
    ] as const) {
      const response = await fetch(publicUrl(key));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(sha256(Buffer.from(await response.arrayBuffer()))).toBe(sha256(bytes));
    }

    await deletePublicObjects([thumbKey, videoKey, neverWritten]);

    const { publicBucket } = storageConfig();
    for (const key of [thumbKey, videoKey]) {
      expect((await fetch(publicUrl(key))).ok).toBe(false);
      await expect(
        storageClient().send(new HeadObjectCommand({ Bucket: publicBucket, Key: key })),
      ).rejects.toMatchObject({ name: "NotFound" });
    }
  }, 30_000);

  it("deleting none is a no-op", async () => {
    await expect(deletePublicObjects([])).resolves.toBeUndefined();
  });
});
