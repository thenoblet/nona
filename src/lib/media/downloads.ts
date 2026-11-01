import type { PgBoss } from "pg-boss";
import { getBoss } from "@/lib/jobs/boss";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { isHeic, type DownloadableItem } from "./album";
import { downloadFilename } from "./album-item";

/*
 * Single downloads (Task 15, gate B 1b): what each of the viewer's choices downloads. A photo's
 * original; a video's phone version (the H.264 conversion, else the clean copy) or its original; an
 * iPhone photo's full-size JPEG, made by media.jpeg on its first request (Noblet, 30 and 31 Oct:
 * originals stay downloadable for everyone, as shared, location included).
 */

export const DOWNLOAD_VARIANTS = ["original", "converted", "jpeg"] as const;
export type DownloadVariant = (typeof DOWNLOAD_VARIANTS)[number];

export type DownloadPlan =
  /** Download this key from this bucket, under this name. */
  | { status: "ready"; bucket: "private" | "public"; key: string; filename: string }
  /** A HEIC's JPEG isn't made yet: its job is to be sent, and the phone asks again. */
  | { status: "preparing" }
  /** A video with no phone version yet. */
  | { status: "not-ready" }
  /** Nothing of the kind for this item (a JPEG of a photo that isn't a HEIC). */
  | { status: "not-offered" };

function extensionOf(key: string): string {
  return key.split(".").pop()?.toLowerCase() ?? "bin";
}

/**
 * What a variant downloads. Without one: a video's phone version when it has one, else (and for a
 * photo) its original.
 */
export function planDownload(item: DownloadableItem, variant: DownloadVariant | null): DownloadPlan {
  const name = (extension: string) => downloadFilename(item.celebration, item.id, extension);
  const original: DownloadPlan = { status: "ready", bucket: "private", key: item.originalKey, filename: name(extensionOf(item.originalKey)) };
  if (variant === "jpeg") {
    if (!isHeic(item)) return { status: "not-offered" };
    const jpeg = item.derived.jpeg;
    return jpeg ? { status: "ready", bucket: "public", key: jpeg, filename: name("jpg") } : { status: "preparing" };
  }
  const phoneVersion = item.kind === "video" ? (item.derived.video ?? item.derived.playable) : undefined;
  if (variant === "converted") {
    if (item.kind !== "video") return { status: "not-offered" };
    return phoneVersion ? { status: "ready", bucket: "public", key: phoneVersion, filename: name("mp4") } : { status: "not-ready" };
  }
  if (variant === null && phoneVersion) return { status: "ready", bucket: "public", key: phoneVersion, filename: name("mp4") };
  return original;
}

/**
 * How long a HEIC's JPEG job stands for its item: asking again within it (a guest's phone checks
 * every few seconds, or a second guest asks) sends no second job. One made in seconds ends long
 * before; one that failed is sent again by the next ask after it.
 */
const JPEG_JOB_SLOT_SECONDS = 120;

/** Sends media.jpeg `{ mediaId }` for a HEIC's full-size JPEG, at most one per item per slot. Throws when the queue refuses. */
export async function requestFullSizeJpeg(
  mediaId: string,
  jobQueue: () => Promise<Pick<PgBoss, "send">> = () => getBoss(),
): Promise<void> {
  const queue = await jobQueue();
  await queue.send(MEDIA_QUEUES.jpeg, { mediaId }, { singletonKey: mediaId, singletonSeconds: JPEG_JOB_SLOT_SECONDS });
}
