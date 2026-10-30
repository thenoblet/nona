import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, describe, expect, it } from "vitest";
import { storageConfig } from "@/lib/env";
import { storageClient } from "./client";
import { manifestKey } from "./keys";
import { readManifest, writeManifest, type MediaManifest } from "./manifest";

// These run against the local MinIO: docker compose up -d minio && npm run storage:init.

const writtenManifests: string[] = [];

afterAll(async () => {
  const { privateBucket } = storageConfig();
  await Promise.all(
    writtenManifests.map((mediaId) =>
      storageClient().send(new DeleteObjectCommand({ Bucket: privateBucket, Key: manifestKey(mediaId) })),
    ),
  );
});

function newMediaId(): string {
  const mediaId = randomUUID();
  writtenManifests.push(mediaId);
  return mediaId;
}

const justUploaded: MediaManifest = {
  celebration: "reception",
  celebrationSetByAdmin: false,
  hiddenAt: null,
  hiddenBy: null,
  removedByUploader: false,
  deletedAt: null,
};

describe("the manifest", () => {
  it("is overwritten by every write", async () => {
    const mediaId = newMediaId();
    await writeManifest(mediaId, justUploaded);
    expect(await readManifest(mediaId)).toEqual(justUploaded);

    const movedAndHidden: MediaManifest = {
      celebration: "ceremony",
      celebrationSetByAdmin: true,
      hiddenAt: new Date("2026-12-05T21:30:00.000Z"),
      hiddenBy: "admin",
      removedByUploader: false,
      deletedAt: null,
    };
    await writeManifest(mediaId, movedAndHidden);
    expect(await readManifest(mediaId)).toEqual(movedAndHidden);

    const removed: MediaManifest = {
      ...movedAndHidden,
      removedByUploader: true,
      deletedAt: new Date("2027-01-10T09:00:00.000Z"),
    };
    await writeManifest(mediaId, removed);
    expect(await readManifest(mediaId)).toEqual(removed);
  });

  it("is plain JSON under manifests/ in the private bucket, readable without the app", async () => {
    const mediaId = newMediaId();
    await writeManifest(mediaId, { ...justUploaded, celebration: "more" });

    const { privateBucket } = storageConfig();
    const stored = await storageClient().send(
      new GetObjectCommand({ Bucket: privateBucket, Key: `manifests/${mediaId}.json` }),
    );
    expect(stored.ContentType).toBe("application/json");
    expect(JSON.parse((await stored.Body?.transformToString()) ?? "null")).toEqual({
      version: 1,
      mediaId,
      celebration: "more",
      celebrationSetByAdmin: false,
      hiddenAt: null,
      hiddenBy: null,
      removedByUploader: false,
      deletedAt: null,
    });
  });

  it("is null before the first write", async () => {
    expect(await readManifest(randomUUID())).toBeNull();
  });

  it("refuses an unsafe media id", async () => {
    await expect(writeManifest("../escape", justUploaded)).rejects.toThrow("mediaId");
  });
});
