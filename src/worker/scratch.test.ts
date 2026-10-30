import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { completeMultipart, startMultipart } from "@/lib/storage/objects";
import { freeScratchBytes, prepareScratchRoot, saveOriginal, ScratchSpaceError, withScratch } from "./scratch";

let root: string;
const roots: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nona-scratch-test-"));
  roots.push(root);
  await prepareScratchRoot(root);
});

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe("withScratch", () => {
  it("gives the job an empty folder of its own under the scratch root, and removes it after", async () => {
    let jobFolder = "";
    const result = await withScratch(1024, async (folder) => {
      jobFolder = folder;
      expect(folder.startsWith(root)).toBe(true);
      expect(await readdir(folder)).toEqual([]);
      await writeFile(join(folder, "original.bin"), randomBytes(1024));
      return "done";
    });
    expect(result).toBe("done");
    expect(await exists(jobFolder)).toBe(false);
  });

  it("removes the folder when the job throws, and passes the error on", async () => {
    let jobFolder = "";
    await expect(
      withScratch(1024, async (folder) => {
        jobFolder = folder;
        await mkdir(join(folder, "frames"));
        await writeFile(join(folder, "frames", "0001.png"), randomBytes(64));
        throw new Error("ffmpeg exited with 1");
      }),
    ).rejects.toThrow("ffmpeg exited with 1");
    expect(jobFolder).not.toBe("");
    expect(await exists(jobFolder)).toBe(false);
  });

  it("refuses to start when the disk has less free space than the job needs, and makes no folder", async () => {
    const free = await freeScratchBytes();
    let ran = false;
    await expect(
      withScratch(free * 2 + 1, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(ScratchSpaceError);
    expect(ran).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("gives two jobs at once two different folders", async () => {
    const folders = await Promise.all([withScratch(1, async (folder) => folder), withScratch(1, async (folder) => folder)]);
    expect(new Set(folders).size).toBe(2);
  });
});

describe("prepareScratchRoot", () => {
  it("removes the folders a stopped worker left, and nothing else it finds there", async () => {
    // A job folder a killed worker left behind, and a file that isn't the worker's.
    let leftBehind = "";
    await withScratch(1, async (folder) => {
      leftBehind = `${folder}-copy`;
      await mkdir(leftBehind);
      await writeFile(join(leftBehind, "original.mov"), randomBytes(16));
    });
    await writeFile(join(root, "lost+found.txt"), "not the worker's");

    await prepareScratchRoot(root);
    expect(await exists(leftBehind)).toBe(false);
    expect(await readdir(root)).toEqual(["lost+found.txt"]);
  });

  it("makes the root if it is missing", async () => {
    const missing = join(root, "not-yet");
    await prepareScratchRoot(missing);
    expect(await exists(missing)).toBe(true);
  });
});

describe("saveOriginal", () => {
  // Against the local MinIO: docker compose up -d minio && npm run storage:init.
  const keys: string[] = [];

  afterAll(async () => {
    if (keys.length === 0) return;
    await storageClient().send(
      new DeleteObjectsCommand({
        Bucket: storageConfig().privateBucket,
        Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
  });

  async function storeOriginal(bytes: Uint8Array): Promise<string> {
    const key = originalKey(randomUUID(), "jpg");
    keys.push(key);
    const uploadId = await startMultipart(key, "image/jpeg", {
      guestId: null,
      uploaderName: "",
      originalFilename: "IMG_0001.JPG",
      startedAt: new Date(),
    });
    const part = await storageClient().send(
      new UploadPartCommand({
        Bucket: storageConfig().privateBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: bytes,
      }),
    );
    await completeMultipart(key, uploadId, [{ partNumber: 1, etag: part.ETag ?? "" }]);
    return key;
  }

  it("streams an original into the job's folder, bounded by the job's signal", async () => {
    const bytes = randomBytes(256 * 1024);
    const key = await storeOriginal(bytes);
    await withScratch(bytes.length, async (folder) => {
      const path = join(folder, "original");
      await saveOriginal(key, path, AbortSignal.timeout(30_000));
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    });
  });

  it("stops when the job's signal is aborted", async () => {
    const key = await storeOriginal(randomBytes(1024));
    const stopped = new AbortController();
    stopped.abort(new Error("the job expired"));
    await withScratch(1024, async (folder) => {
      await expect(saveOriginal(key, join(folder, "original"), stopped.signal)).rejects.toThrow();
    });
  });
});

afterAll(async () => {
  await Promise.all(roots.map((folder) => rm(folder, { recursive: true, force: true })));
});
