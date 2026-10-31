import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectsCommand, UploadPartCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { storageClient } from "@/lib/storage/client";
import { originalKey } from "@/lib/storage/keys";
import { completeMultipart, startMultipart } from "@/lib/storage/objects";
import {
  checkScratchRoot,
  freeScratchBytes,
  prepareScratchRoot,
  saveOriginal,
  ScratchFolderError,
  ScratchSpaceError,
  withScratch,
} from "./scratch";

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

describe("checkScratchRoot: a scratch folder the worker can't use is said plainly", () => {
  const plainLine = (path: string) => `can't use the scratch folder ${path}: mount /mnt/nona-worker at /scratch, writable by uid 10001`;

  async function refusal(path: string): Promise<unknown> {
    return checkScratchRoot(path).then(
      () => null,
      (error: unknown) => error,
    );
  }

  it("takes a folder it can write in, making it if it is missing, and leaves nothing in it", async () => {
    await checkScratchRoot(root);
    const missing = join(root, "not-yet");
    await checkScratchRoot(missing);
    expect(await readdir(root)).toEqual(["not-yet"]);
    expect(await readdir(missing)).toEqual([]);
  });

  it("refuses a folder it can't write in (a mount owned by another user), with one plain line and no EACCES", async () => {
    const readOnly = join(root, "read-only");
    await mkdir(readOnly);
    await chmod(readOnly, 0o555);
    try {
      const error = await refusal(readOnly);
      expect(error).toBeInstanceOf(ScratchFolderError);
      expect((error as Error).message).toBe(plainLine(readOnly));
      // Nor one it would have to make there: the missing mount's case.
      expect(((await refusal(join(readOnly, "scratch"))) as Error).message).toBe(plainLine(join(readOnly, "scratch")));
    } finally {
      await chmod(readOnly, 0o755);
    }
  });

  it("refuses a path that is a file, or under one", async () => {
    const file = join(root, "scratch");
    await writeFile(file, "not a folder");
    for (const path of [file, join(file, "inside")]) {
      const error = await refusal(path);
      expect(error, path).toBeInstanceOf(ScratchFolderError);
      expect((error as Error).message).toBe(plainLine(path));
      expect((error as Error).message).not.toMatch(/EACCES|ENOTDIR|EEXIST/);
    }
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
