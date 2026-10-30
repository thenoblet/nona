import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import type { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { CALL_DEADLINE_MILLISECONDS, createStorageClient, type CallOptions } from "./client";
import { derivedKey, originalKey } from "./keys";
import { readManifest, writeManifest } from "./manifest";
import {
  abortMultipart,
  completeMultipart,
  deletePublicObjects,
  headOriginal,
  listUploadedParts,
  putPublicObject,
  readOriginalStream,
  startMultipart,
} from "./objects";

// An R2 that stalls, the way a bad edge or a dropped connection can:
// - a HEAD request is never answered at all;
// - any other request gets its headers and the start of a 5,000-byte body, then nothing more.
// The request timeout (10 s) stops once headers arrive, so only the call's deadline ends these.
let stallingServer: Server;
let stallingClient: S3Client;
const globalWithStorage = globalThis as { __nonaStorage?: S3Client };
let realClient: S3Client | undefined;

beforeAll(async () => {
  stallingServer = createServer((request, response) => {
    if (request.method === "HEAD") return;
    response.writeHead(200, { "content-type": "application/xml", "content-length": "5000" });
    response.write('<?xml version="1.0" encoding="UTF-8"?><Result>');
  });
  await new Promise<void>((resolve) => stallingServer.listen(0, "127.0.0.1", resolve));
  const { port } = stallingServer.address() as AddressInfo;
  stallingClient = createStorageClient({ ...storageConfig(), endpoint: `http://127.0.0.1:${port}` });
  // The operations use the process's one client; point it at the stalling server for this file.
  realClient = globalWithStorage.__nonaStorage;
  globalWithStorage.__nonaStorage = stallingClient;
});

afterAll(async () => {
  globalWithStorage.__nonaStorage = realClient;
  stallingClient.destroy();
  stallingServer.closeAllConnections();
  await new Promise((resolve) => stallingServer.close(resolve));
});

async function readAll(stream: Readable): Promise<void> {
  for await (const chunk of stream) void chunk;
}

const mediaId = randomUUID();
const original = originalKey(mediaId, "jpg");
const derived = derivedKey(mediaId, "content-hash", "thumb", "webp");
const metadata = {
  guestId: randomUUID(),
  uploaderName: "Ama",
  originalFilename: "a.jpg",
  startedAt: new Date(),
};
const manifest = {
  celebration: "reception" as const,
  celebrationSetByAdmin: false,
  hiddenAt: null,
  hiddenBy: null,
  removedByUploader: false,
  deletedAt: null,
};

/** Every call that isn't a stream, each given these options. */
function callsThatArentStreams(options?: CallOptions): Record<string, () => Promise<unknown>> {
  return {
    startMultipart: () => startMultipart(original, "image/jpeg", metadata, options),
    listUploadedParts: () => listUploadedParts(original, "upload-id", options),
    completeMultipart: () =>
      completeMultipart(original, "upload-id", [{ partNumber: 1, etag: '"etag"' }], options),
    abortMultipart: () => abortMultipart(original, "upload-id", options),
    headOriginal: () => headOriginal(original, options),
    deletePublicObjects: () => deletePublicObjects([derived], options),
    writeManifest: () => writeManifest(mediaId, manifest, options),
    readManifest: () => readManifest(mediaId, options),
  };
}

/** Runs each call at once and reports how many seconds each took to fail (or "resolved"). */
async function secondsToFail(
  calls: Record<string, () => Promise<unknown>>,
): Promise<Record<string, number | string>> {
  const outcomes = await Promise.all(
    Object.entries(calls).map(async ([name, call]) => {
      // performance.now() is monotonic: the wall clock can jump (WSL resyncs it) mid-test.
      const started = performance.now();
      try {
        await call();
        return [name, "resolved"] as const;
      } catch {
        return [name, Math.round((performance.now() - started) / 100) / 10] as const;
      }
    }),
  );
  return Object.fromEntries(outcomes);
}

describe("a call that isn't a stream", () => {
  it("gives up after 15 s in all against a stalling R2, body and retry included, even with a caller's signal that never fires", async () => {
    // Ruling K: a route passes request.signal, which may never fire while the guest's phone keeps
    // the connection open; the 15 s bound must hold all the same. Both run at once, so the test
    // still takes 15 s.
    const neverFires = new AbortController().signal;
    const seconds = await secondsToFail({
      ...callsThatArentStreams(),
      ...Object.fromEntries(
        Object.entries(callsThatArentStreams({ signal: neverFires })).map(([name, call]) => [
          `${name} with the caller's signal`,
          call,
        ]),
      ),
    });
    const deadline = CALL_DEADLINE_MILLISECONDS / 1000;
    expect(Object.keys(seconds)).toHaveLength(16);
    for (const [name, taken] of Object.entries(seconds)) {
      expect(taken, name).toBeGreaterThanOrEqual(deadline - 0.5);
      expect(taken, name).toBeLessThan(deadline + 2);
    }
  }, 25_000);

  it("gives up sooner when the caller's signal says so", async () => {
    const seconds = await secondsToFail(callsThatArentStreams({ signal: AbortSignal.timeout(1000) }));
    for (const [name, taken] of Object.entries(seconds)) {
      expect(taken, name).toBeGreaterThanOrEqual(0.9);
      expect(taken, name).toBeLessThan(3);
    }
  }, 10_000);
});

describe("a stream", () => {
  it("ends when the caller's signal says so, before its own idle cut-off", async () => {
    const signal = () => ({ signal: AbortSignal.timeout(1000) });
    const seconds = await secondsToFail({
      readOriginalStream: async () => readAll(await readOriginalStream(original, signal())),
      putPublicObject: () => putPublicObject(derived, "bytes", "image/webp", signal()),
    });
    for (const [name, taken] of Object.entries(seconds)) {
      expect(taken, name).toBeGreaterThanOrEqual(0.9);
      expect(taken, name).toBeLessThan(3);
    }
  }, 10_000);
});
