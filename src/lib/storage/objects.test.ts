import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { DeleteObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { createStorageClient, storageClient } from "./client";
import { derivedKey, manifestKey, originalKey, publicUrl } from "./keys";
import { fitOriginalMetadata, METADATA_TEXT_BYTES, type OriginalMetadata } from "./metadata";
import {
  abortMultipart,
  completeMultipart,
  deleteOriginal,
  deletePublicObjects,
  DOWNLOAD_URL_SECONDS,
  headOriginal,
  listDerivedKeys,
  listUploadedParts,
  PLAYBACK_URL_SECONDS,
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

/** The metadata Task 7 writes for a guest's upload. */
function guestUpload(overrides: Partial<OriginalMetadata> = {}): OriginalMetadata {
  return {
    guestId: randomUUID(),
    uploaderName: "Ama",
    originalFilename: "IMG_0001.JPG",
    startedAt: new Date("2026-12-05T15:04:05.000Z"),
    ...overrides,
  };
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
async function uploadWhole(key: string, contentType: string, metadata: OriginalMetadata, bytes: Buffer) {
  const uploadId = await startMultipart(key, contentType, metadata);
  const [part] = await presignParts(key, uploadId, [{ partNumber: 1, size: bytes.length }]);
  const etag = await putPartFromBrowser(part.url, bytes);
  await completeMultipart(key, uploadId, [{ partNumber: 1, etag }]);
}

describe("a multipart upload", () => {
  it("round-trips parts PUT from the browser, with each ETag read from its PUT", async () => {
    const key = newOriginalKey("mp4");
    const firstPart = randomBytes(FIVE_MEBIBYTES);
    const lastPart = randomBytes(1000);

    const uploadId = await startMultipart(key, "video/mp4", guestUpload());
    const urls = await presignParts(key, uploadId, [
      { partNumber: 1, size: FIVE_MEBIBYTES },
      { partNumber: 2, size: 1000 },
    ]);
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

  it("presigns at most 20 parts at a time, each for an hour, signed for the host and the part's length alone", async () => {
    const key = newOriginalKey();
    const uploadId = await startMultipart(key, "image/jpeg", guestUpload());
    const parts = Array.from({ length: 20 }, (_value, index) => ({ partNumber: index + 1, size: FIVE_MEBIBYTES }));

    const urls = await presignParts(key, uploadId, parts);
    expect(urls.map((entry) => entry.partNumber)).toEqual(parts.map((part) => part.partNumber));
    for (const { partNumber, url } of urls) {
      const query = new URL(url).searchParams;
      expect(query.get("partNumber")).toBe(String(partNumber));
      expect(query.get("uploadId")).toBe(uploadId);
      expect(query.get("X-Amz-Expires")).toBe("3600");
      // The browser sends no headers of its own, and no checksum; it sets Content-Length itself.
      expect(query.get("X-Amz-SignedHeaders")).toBe("content-length;host");
      expect([...query.keys()].filter((name) => name.toLowerCase().includes("checksum"))).toEqual([]);
    }

    await expect(presignParts(key, uploadId, [...parts, { partNumber: 21, size: 1 }])).rejects.toThrow("20");
    await expect(presignParts(key, uploadId, [])).rejects.toThrow("part");
    for (const partNumber of [0, 10_001, 1.5, Number.NaN]) {
      await expect(presignParts(key, uploadId, [{ partNumber, size: 1 }])).rejects.toThrow("part");
    }
    // S3 takes parts of 1 byte to 5 GiB.
    for (const size of [0, -1, 1.5, Number.NaN, 5 * 1024 ** 3 + 1]) {
      await expect(presignParts(key, uploadId, [{ partNumber: 1, size }])).rejects.toThrow("size");
    }
    await abortMultipart(key, uploadId);
  });

  it("binds each part's URL to its size: the exact size is taken, a larger or smaller body refused", async () => {
    const key = newOriginalKey("mp4");
    const uploadId = await startMultipart(key, "video/mp4", guestUpload());
    const [first, last] = await presignParts(key, uploadId, [
      { partNumber: 1, size: FIVE_MEBIBYTES },
      { partNumber: 2, size: 1000 },
    ]);

    // A client that declared a small file can't fill R2 past it through the same URL.
    for (const size of [FIVE_MEBIBYTES + 1, 50 * 1024 * 1024]) {
      const response = await fetch(first.url, { method: "PUT", body: new Uint8Array(size) });
      expect(response.status, String(size)).toBe(403);
    }
    for (const size of [1001, 999]) {
      expect((await fetch(last.url, { method: "PUT", body: new Uint8Array(size) })).status, String(size)).toBe(403);
    }
    expect(await listUploadedParts(key, uploadId)).toEqual([]);

    const firstEtag = await putPartFromBrowser(first.url, randomBytes(FIVE_MEBIBYTES));
    const lastEtag = await putPartFromBrowser(last.url, randomBytes(1000));
    await completeMultipart(key, uploadId, [
      { partNumber: 1, etag: firstEtag },
      { partNumber: 2, etag: lastEtag },
    ]);
    expect((await headOriginal(key))?.size).toBe(FIVE_MEBIBYTES + 1000);
  }, 30_000);

  it("aborts, after which the upload can't be completed, and aborting again is fine", async () => {
    const key = newOriginalKey();
    const uploadId = await startMultipart(key, "image/jpeg", guestUpload());
    const [part] = await presignParts(key, uploadId, [{ partNumber: 1, size: 2048 }]);
    const etag = await putPartFromBrowser(part.url, randomBytes(2048));

    expect(await abortMultipart(key, uploadId)).toBe("aborted");
    await expect(listUploadedParts(key, uploadId)).rejects.toMatchObject({ name: "NoSuchUpload" });
    // What a cancel relies on: once the abort returns, no complete can make the original.
    await expect(completeMultipart(key, uploadId, [{ partNumber: 1, etag }])).rejects.toMatchObject({
      name: "NoSuchUpload",
    });
    expect(await headOriginal(key)).toBeNull();
    expect(["aborted", "gone"]).toContain(await abortMultipart(key, uploadId));
  });

  it("leaves the original of an upload already completed as it is, whatever the abort answers", async () => {
    // MinIO accepts the abort ("aborted"); a store may say NoSuchUpload ("gone"). Either way,
    // the original stays, so a cancel checks for it rather than trusting the answer.
    const key = newOriginalKey();
    const uploadId = await startMultipart(key, "image/jpeg", guestUpload());
    const [part] = await presignParts(key, uploadId, [{ partNumber: 1, size: 2048 }]);
    const etag = await putPartFromBrowser(part.url, randomBytes(2048));
    await completeMultipart(key, uploadId, [{ partNumber: 1, etag }]);
    expect(["aborted", "gone"]).toContain(await abortMultipart(key, uploadId));
    expect((await headOriginal(key))?.size).toBe(2048);
  });

  it("says gone when the store answers NoSuchUpload, and throws on any other error", async () => {
    // A stand-in store whose every answer is the error named in the path's upload id.
    const answering = createServer((request, response) => {
      const code = new URL(request.url ?? "/", "http://localhost").searchParams.get("uploadId");
      response.writeHead(code === "NoSuchUpload" ? 404 : 500, { "content-type": "application/xml" });
      response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>m</Message></Error>`);
    });
    await new Promise<void>((resolve) => answering.listen(0, "127.0.0.1", resolve));
    const { port } = answering.address() as AddressInfo;
    const globalWithStorage = globalThis as { __nonaStorage?: S3Client };
    const realClient = globalWithStorage.__nonaStorage;
    globalWithStorage.__nonaStorage = createStorageClient({ ...storageConfig(), endpoint: `http://127.0.0.1:${port}` });
    try {
      const key = newOriginalKey();
      expect(await abortMultipart(key, "NoSuchUpload")).toBe("gone");
      await expect(abortMultipart(key, "InternalError")).rejects.toMatchObject({ name: "InternalError" });
    } finally {
      globalWithStorage.__nonaStorage?.destroy();
      globalWithStorage.__nonaStorage = realClient;
      answering.closeAllConnections();
      await new Promise((resolve) => answering.close(resolve));
    }
  });
});

describe("headOriginal", () => {
  it("reads back the original's metadata, with names and filenames in any script", async () => {
    const key = newOriginalKey("heic");
    const metadata = guestUpload({
      uploaderName: "Ama Ɔdɔ & Kwame 😊",
      originalFilename: "IMG_0001 (copy) 100% é.HEIC",
    });
    await uploadWhole(key, "image/heic", metadata, randomBytes(2048));

    expect(await headOriginal(key)).toEqual({
      size: 2048,
      contentType: "image/heic",
      etag: expect.stringMatching(/^".+"$/),
      lastModified: expect.any(Date),
      metadata,
    });
  });

  it("keeps a long name and filename to S3's metadata limit, cut between characters", async () => {
    // Encoded, Ɔ is 6 bytes and an emoji 12: in full these are 2,400 and 2,412 bytes, and S3
    // refuses more than 2 KB in all.
    const metadata = guestUpload({
      uploaderName: "Ɔ".repeat(400),
      originalFilename: `${"😊".repeat(200)}.jpg`,
    });
    const fitted = fitOriginalMetadata(metadata);
    expect(fitted.uploaderName).toBe("Ɔ".repeat(Math.floor(METADATA_TEXT_BYTES / 6)));
    expect(fitted.originalFilename).toBe("😊".repeat(Math.floor(METADATA_TEXT_BYTES / 12)));

    const key = newOriginalKey();
    await uploadWhole(key, "image/jpeg", metadata, randomBytes(64));
    expect((await headOriginal(key))?.metadata).toEqual(fitted);
  });

  it("keeps no guest id for an upload that isn't a guest's, and no name when none was given", async () => {
    const key = newOriginalKey();
    const metadata = guestUpload({ guestId: null, uploaderName: "" });
    await uploadWhole(key, "image/jpeg", metadata, randomBytes(64));
    expect((await headOriginal(key))?.metadata).toEqual(metadata);
  });

  it("refuses a guest id that isn't plain letters, digits, - and _", async () => {
    for (const guestId of ["", "guest id", "gäst", "a/b", "x".repeat(129)]) {
      await expect(startMultipart(newOriginalKey(), "image/jpeg", guestUpload({ guestId }))).rejects.toThrow(
        "guest id",
      );
    }
  });

  it("reads no metadata from an original that startMultipart didn't start", async () => {
    const key = newOriginalKey();
    await storageClient().send(
      new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: "bytes" }),
    );
    expect(await headOriginal(key)).toMatchObject({ size: 5, metadata: null });
  });

  it("is null when there is no such original", async () => {
    expect(await headOriginal(originalKey(randomUUID(), "jpg"))).toBeNull();
  });
});

describe("presignGet", () => {
  const bytes = randomBytes(512);
  const key = newOriginalKey();

  beforeAll(() => uploadWhole(key, "image/jpeg", guestUpload(), bytes));

  it("names the download with the filename it is given", async () => {
    const url = await presignGet(key, {
      filename: "NONA26-reception-ab12cd.jpg",
      expiresInSeconds: DOWNLOAD_URL_SECONDS,
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
    const url = await presignGet(key, { expiresInSeconds: PLAYBACK_URL_SECONDS });
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

  it("presigns originals only, never a manifest or a derived file", async () => {
    const mediaId = randomUUID();
    for (const elsewhere of [manifestKey(mediaId), derivedKey(mediaId, "content-hash", "view", "webp")]) {
      await expect(presignGet(elsewhere, { expiresInSeconds: 60 })).rejects.toThrow("originals/");
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

  it("are listed by item, whatever their content hash, and nothing of another item's", async () => {
    const mediaId = randomUUID();
    const other = randomUUID();
    const keys = [
      derivedKey(mediaId, "first-hash", "thumb", "webp"),
      derivedKey(mediaId, "first-hash", "view", "webp"),
      derivedKey(mediaId, "second-hash", "video", "mp4"),
    ];
    const othersKey = derivedKey(other, "first-hash", "thumb", "webp");
    for (const key of [...keys, othersKey]) await putPublicObject(key, "bytes", "image/webp");

    try {
      expect((await listDerivedKeys(mediaId)).sort()).toEqual([...keys].sort());
      expect(await listDerivedKeys(randomUUID())).toEqual([]);
    } finally {
      await deletePublicObjects([...keys, othersKey]);
    }
    expect(await listDerivedKeys(mediaId)).toEqual([]);
  });
});

describe("deleteOriginal", () => {
  it("deletes the original, and is fine when it is gone already", async () => {
    const key = newOriginalKey();
    await storageClient().send(new PutObjectCommand({ Bucket: storageConfig().privateBucket, Key: key, Body: "original" }));
    expect(await headOriginal(key)).not.toBeNull();

    await deleteOriginal(key);
    expect(await headOriginal(key)).toBeNull();
    await expect(deleteOriginal(key)).resolves.toBeUndefined();
  });
});

describe("every operation", () => {
  it("refuses a key from the wrong place before it calls R2", async () => {
    const mediaId = randomUUID();
    const original = originalKey(mediaId, "jpg");
    const derived = derivedKey(mediaId, "content-hash", "thumb", "webp");
    const manifest = manifestKey(mediaId);
    const notOriginals = [derived, manifest, "originals/../manifests/x.json", "zips/all.zip"];
    const notDerived = [original, manifest, "derived/x.webp"];

    for (const key of notOriginals) {
      await expect(startMultipart(key, "image/jpeg", guestUpload()), key).rejects.toThrow("originals/");
      await expect(presignParts(key, "upload-id", [{ partNumber: 1, size: 1 }]), key).rejects.toThrow("originals/");
      await expect(listUploadedParts(key, "upload-id"), key).rejects.toThrow("originals/");
      await expect(completeMultipart(key, "upload-id", []), key).rejects.toThrow("originals/");
      await expect(abortMultipart(key, "upload-id"), key).rejects.toThrow("originals/");
      await expect(headOriginal(key), key).rejects.toThrow("originals/");
      await expect(readOriginalStream(key), key).rejects.toThrow("originals/");
      await expect(deleteOriginal(key), key).rejects.toThrow("originals/");
    }
    await expect(listDerivedKeys("../originals")).rejects.toThrow("mediaId");
    for (const key of notDerived) {
      await expect(putPublicObject(key, "bytes", "text/plain"), key).rejects.toThrow("derived/");
      await expect(deletePublicObjects([derived, key]), key).rejects.toThrow("derived/");
    }
  });
});
