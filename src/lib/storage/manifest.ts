import "server-only";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import * as zod from "zod";
import { EVENT_IDS, type EventId } from "@/lib/content/schema";
import { storageConfig } from "@/lib/env";
import { storageClient, withDeadline, type CallOptions } from "./client";
import { manifestKey } from "./keys";

/**
 * The facts about an item that change after its upload starts. They live beside the originals,
 * in `manifests/<mediaId>.json` in the private bucket, rewritten on every change, so the album can
 * be rebuilt from R2 alone with hidden items still hidden and moves kept. (The facts known at the
 * start are the original's own metadata, which never changes.)
 */
export type MediaManifest = {
  celebration: EventId | "more";
  celebrationSetByAdmin: boolean;
  hiddenAt: Date | null;
  hiddenBy: string | null;
  removedByUploader: boolean;
  deletedAt: Date | null;
};

/** A manifest as read back, with the time it was last written. */
export type StoredManifest = MediaManifest & { updatedAt: Date };

const MANIFEST_VERSION = 1;

const isoTime = zod.iso.datetime().transform((value) => new Date(value));

const storedManifest = zod.object({
  version: zod.literal(MANIFEST_VERSION),
  mediaId: zod.string(),
  celebration: zod.enum([...EVENT_IDS, "more"]),
  celebrationSetByAdmin: zod.boolean(),
  hiddenAt: isoTime.nullable(),
  hiddenBy: zod.string().nullable(),
  removedByUploader: zod.boolean(),
  deletedAt: isoTime.nullable(),
  updatedAt: isoTime,
});

/** Replaces the item's manifest with this one, stamped with the time of writing. */
export async function writeManifest(
  mediaId: string,
  manifest: MediaManifest,
  options?: CallOptions,
): Promise<void> {
  const key = manifestKey(mediaId);
  const stored = {
    version: MANIFEST_VERSION,
    mediaId,
    celebration: manifest.celebration,
    celebrationSetByAdmin: manifest.celebrationSetByAdmin,
    hiddenAt: manifest.hiddenAt?.toISOString() ?? null,
    hiddenBy: manifest.hiddenBy,
    removedByUploader: manifest.removedByUploader,
    deletedAt: manifest.deletedAt?.toISOString() ?? null,
    updatedAt: new Date().toISOString(),
  };
  await storageClient().send(
    new PutObjectCommand({
      Bucket: storageConfig().privateBucket,
      Key: key,
      Body: JSON.stringify(stored),
      ContentType: "application/json",
    }),
    withDeadline(options),
  );
}

/**
 * The item's manifest, or null when none has been written. Throws when the file names another
 * item, so a manifest copied to the wrong key is never taken for this one.
 */
export async function readManifest(mediaId: string, options?: CallOptions): Promise<StoredManifest | null> {
  const key = manifestKey(mediaId);
  let text: string | undefined;
  try {
    // The deadline covers reading the body too.
    const response = await storageClient().send(
      new GetObjectCommand({ Bucket: storageConfig().privateBucket, Key: key }),
      withDeadline(options),
    );
    text = await response.Body?.transformToString();
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") return null;
    throw error;
  }
  const stored = storedManifest.parse(JSON.parse(text ?? "null"));
  if (stored.mediaId !== mediaId) {
    throw new Error(`The manifest at ${key} is for ${JSON.stringify(stored.mediaId)}, not ${mediaId}`);
  }
  return {
    celebration: stored.celebration,
    celebrationSetByAdmin: stored.celebrationSetByAdmin,
    hiddenAt: stored.hiddenAt,
    hiddenBy: stored.hiddenBy,
    removedByUploader: stored.removedByUploader,
    deletedAt: stored.deletedAt,
    updatedAt: stored.updatedAt,
  };
}
