import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { EventId } from "@/lib/content/schema";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import {
  guests,
  media,
  uploadEvents,
  type CONVERSION_STATES,
  type MEDIA_FILE_KINDS,
  type MEDIA_PURPOSES,
  type MEDIA_STATUSES,
  type UPLOAD_EVENT_KINDS,
} from "@/lib/db/schema";
import type { DerivedVariant } from "@/lib/storage/keys";
import type { MediaManifest } from "@/lib/storage/manifest";

type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];
type MediaStatus = (typeof MEDIA_STATUSES)[number];
type ConversionState = (typeof CONVERSION_STATES)[number];
type UploadEventKind = (typeof UPLOAD_EVENT_KINDS)[number];

/*
 * The media table's queries, shared by the app and the media worker. The worker bundles this file,
 * so it imports only the database, the schema and plain helpers: nothing from next/ and no images
 * (rows.test.ts checks).
 */

/**
 * Whether anyone may see or fetch the item: it isn't hidden, deleted or removed by its uploader.
 * Every presign, download, playback and slideshow path checks this first. An unknown id, or one
 * that isn't a UUID, is not visible.
 */
export async function isVisible(mediaId: string): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const [row] = await getDb().select({ id: media.id }).from(media).where(visibleItem(mediaId)).limit(1);
  return row !== undefined;
}

/** The item, while no one has hidden it (removing one's own upload hides it too) or deleted it: isVisible's condition. */
function visibleItem(mediaId: string) {
  return and(eq(media.id, mediaId), isNull(media.hiddenAt), isNull(media.deletedAt), eq(media.removedByUploader, false));
}

/*
 * The upload API's queries (Task 7). Each is one statement on an index, and none runs inside a
 * transaction: the R2 calls happen between them, never while a row is locked.
 */

/** What the upload API reads of an upload: who owns it, where it is and how far it has got. */
const uploadColumns = {
  id: media.id,
  purpose: media.purpose,
  kind: media.kind,
  guestId: media.guestId,
  uploaderName: media.uploaderName,
  celebration: media.celebration,
  originalKey: media.originalKey,
  originalFilename: media.originalFilename,
  sizeBytes: media.sizeBytes,
  contentType: media.contentType,
  multipartUploadId: media.multipartUploadId,
  startedAt: media.startedAt,
  status: media.status,
  failureReason: media.failureReason,
  hiddenAt: media.hiddenAt,
  deletedAt: media.deletedAt,
  removedByUploader: media.removedByUploader,
};

export type UploadRow = {
  id: string;
  purpose: MediaPurpose;
  kind: MediaFileKind;
  guestId: string | null;
  uploaderName: string | null;
  celebration: EventId | "more";
  originalKey: string;
  originalFilename: string;
  sizeBytes: number;
  contentType: string;
  multipartUploadId: string | null;
  startedAt: Date;
  status: MediaStatus;
  /** Why processing failed (`corrupt`, `unsupported-type`…), shown to its uploader; null otherwise. */
  failureReason: string | null;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  removedByUploader: boolean;
};

/** A new upload's row, before its multipart upload exists. */
export type NewUpload = {
  id: string;
  purpose: MediaPurpose;
  kind: MediaFileKind;
  guestId: string | null;
  uploaderName: string | null;
  celebration: EventId | "more";
  originalKey: string;
  originalFilename: string;
  sizeBytes: number;
  contentType: string;
  fileFingerprint: string | null;
  startedAt: Date;
  capturedAt: Date | null;
};

/**
 * Writes a new upload's row, `uploading` and without a multipart upload id yet. With no name of its
 * own, it takes its guest's, in the same statement. A guest that doesn't exist fails the insert on
 * the foreign key (isUnknownGuest).
 */
export async function insertUpload(upload: NewUpload): Promise<UploadRow> {
  const guestsName = upload.guestId
    ? sql`(select ${guests.displayName} from ${guests} where ${guests.id} = ${upload.guestId})`
    : null;
  const [row] = await getDb()
    .insert(media)
    .values({ ...upload, uploaderName: upload.uploaderName ?? guestsName, status: "uploading" })
    .returning(uploadColumns);
  return row;
}

/** Whether an insert failed because its guest doesn't exist (a cookie older than a database restore). */
export function isUnknownGuest(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause as { code?: unknown; constraint_name?: unknown } | undefined;
  const code = (error as { code?: unknown }).code ?? cause?.code;
  const constraint = (error as { constraint_name?: unknown }).constraint_name ?? cause?.constraint_name;
  return code === "23503" && constraint === "media_guest_id_guests_id_fk";
}

/** The query behind findUpload, exported so a test can check its plan (the primary key). */
export function uploadQuery(mediaId: string) {
  return getDb().select(uploadColumns).from(media).where(eq(media.id, mediaId)).limit(1);
}

/** The upload with this id, or null. Anything that isn't a UUID finds nothing. */
export async function findUpload(mediaId: string): Promise<UploadRow | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await uploadQuery(mediaId);
  return row ?? null;
}

export type ResumableUploadKey = {
  guestId: string;
  purpose: MediaPurpose;
  sizeBytes: number;
  fingerprint: string;
};

/**
 * The query behind findResumableUpload, exported so a test can check its plan. `status =
 * 'uploading'` is written as a literal, not a bound value: only then can Postgres prove the partial
 * resume index applies under a generic plan (a pooled prepared statement's). No ORDER BY, so no
 * sort: two unfinished uploads of one file (two starts at once) are equally good to resume.
 */
export function resumableUploadQuery({ guestId, purpose, sizeBytes, fingerprint }: ResumableUploadKey) {
  return getDb()
    .select(uploadColumns)
    .from(media)
    .where(
      and(
        eq(media.guestId, guestId),
        eq(media.sizeBytes, sizeBytes),
        eq(media.fileFingerprint, fingerprint),
        sql`${media.status} = 'uploading'`,
        eq(media.purpose, purpose),
      ),
    )
    .limit(1);
}

/** The guest's unfinished upload of this file (same purpose, size and fingerprint), or null. */
export async function findResumableUpload(key: ResumableUploadKey): Promise<UploadRow | null> {
  const [row] = await resumableUploadQuery(key);
  return row ?? null;
}

/**
 * The query behind isHiddenByCouple, exported so a test can check its plan. Its conditions are
 * written as literals, as media_couple_hidden_idx's are, so Postgres can prove the partial index
 * applies under a generic plan.
 */
export function coupleHiddenQuery({ sizeBytes, fingerprint }: { sizeBytes: number; fingerprint: string }) {
  return getDb()
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.fileFingerprint, fingerprint),
        eq(media.sizeBytes, sizeBytes),
        sql`${media.hiddenAt} is not null and not ${media.removedByUploader} and ${media.deletedAt} is null`,
      ),
    )
    .limit(1);
}

/**
 * Ruling AX: whether the couple hid an item of this same file (size and fingerprint), whoever
 * uploaded it, so a new upload of it can be refused rather than slip past their moderation. An item
 * its own guest removed doesn't count (they may add it again), nor one deleted for good (its
 * tombstone keeps no fingerprint). The fingerprint is the phone's own claim, so this is a
 * moderation convenience, not a security boundary: a file changed by one byte at either end, or a
 * phone that lies, passes, and the couple moderate it afresh.
 */
export async function isHiddenByCouple(key: { sizeBytes: number; fingerprint: string }): Promise<boolean> {
  return (await coupleHiddenQuery(key)).length > 0;
}

/**
 * Records the upload's multipart upload id, unless another request recorded one first. Returns
 * the id the row now keeps (the other one, if so), or null when the row is gone or no longer
 * uploading.
 */
export async function attachMultipartUpload(mediaId: string, uploadId: string): Promise<string | null> {
  const [row] = await getDb()
    .update(media)
    .set({ multipartUploadId: sql`coalesce(${media.multipartUploadId}, ${uploadId})` })
    .where(and(eq(media.id, mediaId), sql`${media.status} = 'uploading'`))
    .returning({ multipartUploadId: media.multipartUploadId });
  return row?.multipartUploadId ?? null;
}

/**
 * Marks a verified upload `uploaded`, stamped with the database's time. True only for the call
 * that changed it, so a second complete (or two at once) queues no second job.
 */
export async function markUploaded(mediaId: string): Promise<boolean> {
  const rows = await getDb()
    .update(media)
    .set({ status: "uploaded", uploadedAt: sql`now()` })
    .where(and(eq(media.id, mediaId), sql`${media.status} = 'uploading'`))
    .returning({ id: media.id });
  return rows.length > 0;
}

/** Deletes an upload that never finished (a cancel, or one whose start failed). True if it did. */
export async function deleteUnfinishedUpload(mediaId: string): Promise<boolean> {
  const rows = await getDb()
    .delete(media)
    .where(and(eq(media.id, mediaId), sql`${media.status} = 'uploading'`))
    .returning({ id: media.id });
  return rows.length > 0;
}

/** Who uploaded each of these items, by id; an id with no row is left out. One query on the primary key. */
export async function uploadOwners(mediaIds: string[]): Promise<Map<string, string | null>> {
  const ids = mediaIds.filter((id) => isUuid(id));
  if (ids.length === 0) return new Map();
  const rows = await getDb()
    .select({ id: media.id, guestId: media.guestId })
    .from(media)
    .where(inArray(media.id, ids));
  return new Map(rows.map((row) => [row.id, row.guestId]));
}

/*
 * The media worker's queries (Task 8).
 */

/**
 * Marks an item whose processing failed for good (a corrupt file, or retries used up) `failed`, with
 * the short reason its uploader is shown. Never a `ready` item: one whose re-processing failed stays
 * as the album shows it. True if it changed the item.
 */
export async function markProcessingFailed(mediaId: string, reason: string): Promise<boolean> {
  const rows = await getDb()
    .update(media)
    .set({ status: "failed", failureReason: reason })
    .where(and(eq(media.id, mediaId), sql`${media.status} <> 'ready'`))
    .returning({ id: media.id });
  return rows.length > 0;
}

/**
 * Marks a video's conversion failed for good, with the short reason its wording comes from
 * ("too-long", "corrupt", "processing-failed"…). The video itself stays as it was, poster and all,
 * and a conversion already `done` stays done (a later re-conversion failing keeps the copy that
 * works). True if it changed the item.
 */
export async function markConversionFailed(mediaId: string, reason: string): Promise<boolean> {
  const rows = await getDb()
    .update(media)
    .set({ conversion: "failed", conversionFailureReason: reason })
    .where(and(eq(media.id, mediaId), sql`${media.conversion} <> 'done'`))
    .returning({ id: media.id });
  return rows.length > 0;
}

/**
 * Whether a processing job has work to do for the item (Ruling AG): it is `uploaded`, and no one
 * has hidden it (removing one's own upload hides it too) or deleted it. pg-boss can deliver a job
 * twice and the sweeper can queue one again, so a job checks this when it starts and again in the
 * update that finishes it; a hidden item waits, uploaded, for the unhide that queues it again. The
 * finishing update also checks the generation the job made its files for: after an unhide raised
 * it, a job that read the item before would otherwise mark it ready naming files of the old
 * generation, which the hide deleted.
 */
function awaitsProcessing(mediaId: string, derivedGeneration?: number) {
  return and(
    eq(media.id, mediaId),
    sql`${media.status} = 'uploaded'`,
    isNull(media.hiddenAt),
    isNull(media.deletedAt),
    derivedGeneration === undefined ? undefined : eq(media.derivedGeneration, derivedGeneration),
  );
}

/** What a processing job reads of its item before it starts. */
export type ItemToProcess = {
  id: string;
  originalKey: string;
  startedAt: Date;
  /** The time the phone sent, if any: the fallback when the file has none of its own. */
  capturedAt: Date | null;
  /** Which making of its derived files this is, part of their keys (a new one after every unhide). */
  derivedGeneration: number;
};

/** The item, if a processing job has work to do for it (awaitsProcessing); otherwise null. One read on the primary key. */
export async function findItemToProcess(mediaId: string): Promise<ItemToProcess | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .select({
      id: media.id,
      originalKey: media.originalKey,
      startedAt: media.startedAt,
      capturedAt: media.capturedAt,
      derivedGeneration: media.derivedGeneration,
    })
    .from(media)
    .where(awaitsProcessing(mediaId))
    .limit(1);
  return row ?? null;
}

/** What processing made of a photo, for markPhotoReady. */
export type ProcessedPhoto = {
  /** The derived files' keys in the public bucket: the thumbnail and the viewing size. */
  derived: Partial<Record<DerivedVariant, string>>;
  /** The generation they were made for, as findItemToProcess read it: the mark needs it current. */
  derivedGeneration: number;
  /** The upright photo's size in pixels. */
  width: number;
  height: number;
  thumbhash: string;
  averageColor: string;
  /** From the file, else the time the phone sent; null when neither had one. */
  capturedAt: Date | null;
  /** The celebration that time falls in; the couple's own choice wins over it. */
  celebration: EventId | "more";
};

/** What processing made of a video, for markVideoReady: its poster (as a photo's files) and what its probe found. */
export type ProcessedVideo = ProcessedPhoto & {
  /** Null when the container doesn't say (a browser's WebM recording). */
  durationSeconds: number | null;
  videoCodec: string;
  /** Whether every phone's browser plays the original as it is. */
  browserPlayable: boolean;
  /** Whether it gets a backlog conversion: it isn't playable everywhere, or is long. */
  needsConversion: boolean;
  /**
   * Whether it is too long to convert (WORKER_CONVERT_MAX_SECONDS, Ruling AR): its conversion is
   * `failed` with the reason `too-long` at once, and none is ever queued. It plays from its original
   * where a phone can, and its original stays downloadable.
   */
  tooLongToConvert: boolean;
};

/** What an item's ready mark leaves in its manifest: the facts the update returns. */
const manifestColumns = {
  celebration: media.celebration,
  celebrationSetByAdmin: media.celebrationSetByAdmin,
  hiddenAt: media.hiddenAt,
  hiddenBy: media.hiddenBy,
  removedByUploader: media.removedByUploader,
  deletedAt: media.deletedAt,
};

/**
 * The facts the item's manifest holds, as its row has them now, or null when there is no such row.
 * One read on the primary key. syncManifest writes them, and reads them again to check.
 */
export async function manifestFacts(mediaId: string): Promise<MediaManifest | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb().select(manifestColumns).from(media).where(eq(media.id, mediaId)).limit(1);
  return row ?? null;
}

/**
 * The columns every ready mark sets: `ready` and listed now (or keeping its place if it was listed
 * before), with what processing made, in the celebration its capture time falls in unless the
 * couple moved it.
 */
function readyColumns(item: Omit<ProcessedPhoto, "derivedGeneration">) {
  return {
    status: "ready" as const,
    failureReason: null,
    listedAt: sql`coalesce(${media.listedAt}, now())`,
    derived: item.derived,
    width: item.width,
    height: item.height,
    thumbhash: item.thumbhash,
    averageColor: item.averageColor,
    capturedAt: item.capturedAt,
    celebration: sql`case when ${media.celebrationSetByAdmin} then ${media.celebration} else ${item.celebration} end`,
  };
}

/**
 * Marks a processed photo `ready` with what its processing made, in one statement and only while a
 * job still has work to do for it (awaitsProcessing), in the generation its files were made for: a
 * second delivery that finished first, a hide while this one worked, or an unhide since it read the
 * item, leaves it as it is. It is listed now, or keeps its place if it was
 * listed before; its celebration is the one its capture time falls in, unless the couple moved it.
 * Returns the facts its manifest holds as this left them, or null when it changed nothing.
 */
export async function markPhotoReady(mediaId: string, photo: ProcessedPhoto): Promise<MediaManifest | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .update(media)
    .set(readyColumns(photo))
    .where(awaitsProcessing(mediaId, photo.derivedGeneration))
    .returning(manifestColumns);
  return row ?? null;
}

/** What markVideoReady did. */
export type VideoReadyMark = {
  /** The facts the item's manifest holds as the mark left them. */
  manifest: MediaManifest;
  /**
   * Whether the video's conversion is `queued` now: this mark queued it (from `none`), or an unhide
   * left it queued for the poster made again (a conversion done or under way before the hide). Its
   * job is to be sent then, once for each ready mark, which happens once each time the item is
   * processed; a job sent twice is harmless anyway (Rulings AG, AQ). The sweeper sends it if that
   * send fails.
   */
  conversionQueued: boolean;
  /** Whether a guest is waiting for it (a phone asked, or the couple made it a highlight): sent at priority 20 then. */
  conversionOnDemand: boolean;
};

/**
 * Marks a probed video `ready` with its poster and probe, as markPhotoReady does a photo, in one
 * statement under the same condition. A video that needs a conversion has it `queued` in the same
 * statement, and one too long to convert has it `failed` (`too-long`), unless its conversion is past
 * `none` already: one an unhide left `queued` stays queued, to be sent. Null when it changed nothing.
 */
export async function markVideoReady(mediaId: string, video: ProcessedVideo): Promise<VideoReadyMark | null> {
  if (!isUuid(mediaId)) return null;
  const fromNone = (state: string) => sql`case when ${media.conversion} = 'none' then ${state} else ${media.conversion} end`;
  const conversionColumns = video.tooLongToConvert
    ? {
        conversion: fromNone("failed"),
        conversionFailureReason: sql`case when ${media.conversion} = 'none' then 'too-long' else ${media.conversionFailureReason} end`,
      }
    : video.needsConversion
      ? { conversion: fromNone("queued") }
      : {};
  const [row] = await getDb()
    .update(media)
    .set({
      ...readyColumns(video),
      durationSeconds: video.durationSeconds,
      videoCodec: video.videoCodec,
      browserPlayable: video.browserPlayable,
      ...conversionColumns,
    })
    .where(awaitsProcessing(mediaId, video.derivedGeneration))
    .returning({
      ...manifestColumns,
      conversion: media.conversion,
      conversionOnDemand: sql<boolean>`${media.highlight} or ${media.conversionRequestedAt} is not null`,
    });
  if (!row) return null;
  const { conversion, conversionOnDemand, ...manifest } = row;
  return { manifest, conversionQueued: conversion === "queued", conversionOnDemand };
}

/*
 * Video conversions (Task 11). A ready video's `conversion` goes `none` → `queued` (it needs one:
 * its poster job found it unplayable or long, a phone asked, or the couple made it a highlight) →
 * `converting` (a media.convert job holds its lease, conversion_job_id) → `done` (its MP4 is
 * `derived.video`), or `failed` with a reason once its job has failed for good, or at once when the
 * video is too long to convert (the video keeps its poster, and plays from its original where a
 * phone can). Only the job holding the lease carries a conversion on, through its retries (pg-boss
 * keeps a job's id across them); any other job finds nothing to do (Ruling AQ). The sweeper puts a
 * conversion whose job is gone back to `queued`.
 */

/** A ready, visible album video: what a phone may ask a playable version of (isVisible's condition, and ready). */
function readyVideo(mediaId: string) {
  return and(
    visibleItem(mediaId),
    sql`${media.status} = 'ready'`,
    eq(media.kind, "video"),
    eq(media.purpose, "album"),
  );
}

/** What the playable route reads of a video. */
export type PlayableVideo = {
  conversion: ConversionState;
  /** The converted MP4's key in the public bucket, once the conversion is done. */
  videoKey: string | null;
  /** When a phone first asked for it: a later ask sends nothing more. */
  requestedAt: Date | null;
  /** Why a `failed` conversion failed. */
  failureReason: string | null;
};

/** The video's conversion, when it is a ready, visible album video; otherwise null. One read on the primary key. */
export async function findPlayableVideo(mediaId: string): Promise<PlayableVideo | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .select({
      conversion: media.conversion,
      videoKey: sql<string | null>`${media.derived} ->> 'video'`,
      requestedAt: media.conversionRequestedAt,
      failureReason: media.conversionFailureReason,
    })
    .from(media)
    .where(readyVideo(mediaId))
    .limit(1);
  return row ?? null;
}

/**
 * Records that a phone asked for a ready, visible video's conversion (conversion_requested_at, which
 * makes it an on-demand one: the sweeper sends it again at the on-demand priority if its job is
 * lost, and a held backlog job goes on at that priority), and queues it if it hadn't been. True only
 * for the first ask, whose caller sends the on-demand job, so asking again never sends a second: the
 * row is the guard. A conversion done or failed, or asked for already, is left as it is.
 */
export async function markConversionRequested(mediaId: string): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const rows = await getDb()
    .update(media)
    .set({
      conversion: sql`case when ${media.conversion} = 'none' then 'queued' else ${media.conversion} end`,
      conversionRequestedAt: sql`now()`,
    })
    .where(
      and(
        readyVideo(mediaId),
        sql`${media.conversion} in ('none', 'queued', 'converting')`,
        isNull(media.conversionRequestedAt),
      ),
    )
    .returning({ id: media.id });
  return rows.length > 0;
}

/** Whether a guest is waiting for the video's conversion: a phone asked for it, or the couple made it a highlight. */
export async function conversionIsOnDemand(mediaId: string): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const [row] = await getDb()
    .select({ onDemand: sql<boolean>`${media.highlight} or ${media.conversionRequestedAt} is not null` })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  return row?.onDemand ?? false;
}

/** What a conversion job reads of its item when it claims it. */
export type ConversionToRun = {
  originalKey: string;
  /** The capture time the poster job settled on: the converted file's creation_time. */
  capturedAt: Date | null;
  /** The poster job's probe of its length, null when the container didn't say. */
  durationSeconds: number | null;
  /** Which making of its derived files this is, part of the converted file's key. */
  derivedGeneration: number;
};

/**
 * Claims the video's conversion for the media.convert job holding `leaseId` (Ruling AG, AQ), in one
 * statement: `converting` under that lease, from `queued`, or carried on from `converting` under the
 * same lease (its own earlier attempt, whose worker died), while the item is ready and neither
 * hidden nor deleted. Null when there is nothing to do: converted already, failed for good, never
 * queued, hidden, deleted, or converting under another job's lease.
 */
export async function claimConversion(mediaId: string, leaseId: string): Promise<ConversionToRun | null> {
  if (!isUuid(mediaId) || !isUuid(leaseId)) return null;
  const [row] = await getDb()
    .update(media)
    .set({ conversion: "converting", conversionJobId: leaseId })
    .where(
      and(
        eq(media.id, mediaId),
        sql`${media.status} = 'ready'`,
        eq(media.kind, "video"),
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        or(
          sql`${media.conversion} = 'queued'`,
          and(sql`${media.conversion} = 'converting'`, eq(media.conversionJobId, leaseId)),
        ),
      ),
    )
    .returning({
      originalKey: media.originalKey,
      capturedAt: media.capturedAt,
      durationSeconds: media.durationSeconds,
      derivedGeneration: media.derivedGeneration,
    });
  return row ?? null;
}

/**
 * Gives up the lease on a conversion that won't finish under it (the item was hidden or deleted
 * while it converted): back to `queued`, so an unhide finds it waiting. Only while `converting`
 * under this lease; never one that is done or failed.
 */
export async function releaseConversion(mediaId: string, leaseId: string): Promise<void> {
  if (!isUuid(mediaId) || !isUuid(leaseId)) return;
  await getDb()
    .update(media)
    .set({ conversion: "queued", conversionJobId: null })
    .where(and(eq(media.id, mediaId), sql`${media.conversion} = 'converting'`, eq(media.conversionJobId, leaseId)));
}

/**
 * Marks the video's conversion `done`, with the converted MP4's key as its `video` derived file, in
 * one statement and only while the item still wants it from this lease (ready, neither hidden nor
 * deleted, converting under `leaseId`): a hide while the job worked leaves it as it is. Returns the
 * facts its manifest holds, or null when it changed nothing.
 */
export async function markConversionDone(mediaId: string, leaseId: string, videoKey: string): Promise<MediaManifest | null> {
  if (!isUuid(mediaId) || !isUuid(leaseId)) return null;
  const [row] = await getDb()
    .update(media)
    .set({
      conversion: "done",
      derived: sql`${media.derived} || jsonb_build_object('video', ${videoKey}::text)`,
    })
    .where(
      and(
        eq(media.id, mediaId),
        sql`${media.status} = 'ready'`,
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        sql`${media.conversion} = 'converting'`,
        eq(media.conversionJobId, leaseId),
      ),
    )
    .returning(manifestColumns);
  return row ?? null;
}

/*
 * Withdrawing an item's public files (Task 12): once an item is hidden or deleted, the media worker's
 * visibility job records every key it will withdraw (withdrawing_keys: the files its row names, any
 * other under its folder, and a permanently deleted item's original), deletes them, purges the
 * public ones' URLs from Cloudflare, and only then clears them and the row's derived keys. Derived
 * keys left on a hidden or deleted item, or any withdrawing key, mean files that may still be
 * public: the sweeper sends a job for any no job is withdrawing.
 */

/** What the visibility job (and a processing job whose mark changed nothing) reads of an item. */
export type ItemToWithdraw = {
  /** isVisible's condition: not hidden, removed or deleted. */
  visible: boolean;
  deleted: boolean;
  /** The derived files its row names. */
  derived: Partial<Record<DerivedVariant, string>>;
  /** Its files' current generation. */
  derivedGeneration: number;
  /** Keys an earlier attempt began to withdraw (withdrawing_keys), still to finish. */
  withdrawingKeys: string[];
  originalKey: string;
  uploadedAt: Date | null;
};

/** What withdrawing an item needs to know of it, or null when there is no such row. One read on the primary key. */
export async function findItemToWithdraw(mediaId: string): Promise<ItemToWithdraw | null> {
  if (!isUuid(mediaId)) return null;
  const [row] = await getDb()
    .select({
      visible: sql<boolean>`${media.hiddenAt} is null and ${media.deletedAt} is null and not ${media.removedByUploader}`,
      deleted: sql<boolean>`${media.deletedAt} is not null`,
      derived: media.derived,
      derivedGeneration: media.derivedGeneration,
      withdrawingKeys: media.withdrawingKeys,
      originalKey: media.originalKey,
      uploadedAt: media.uploadedAt,
    })
    .from(media)
    .where(eq(media.id, mediaId))
    .limit(1);
  return row ? { ...row, withdrawingKeys: row.withdrawingKeys ?? [] } : null;
}

/**
 * Adds keys to the item's withdrawing_keys, before any of them is deleted, so every attempt after
 * this one deletes and purges them all. A union in one statement: two jobs at once lose neither's.
 */
export async function addWithdrawingKeys(mediaId: string, keys: string[]): Promise<void> {
  if (!isUuid(mediaId) || keys.length === 0) return;
  await getDb()
    .update(media)
    .set({
      // The keys go as one JSON array: drizzle would send a JavaScript array as a row of values.
      withdrawingKeys: sql`array(select distinct pending.key from (
        select unnest(coalesce(${media.withdrawingKeys}, '{}'::text[]))
        union select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)) as pending(key))`,
    })
    .where(eq(media.id, mediaId));
}

/**
 * Takes keys whose objects are deleted and purged off the item's withdrawing_keys, in one
 * statement, leaving any another job added meanwhile; null once none is left.
 */
export async function finishWithdrawing(mediaId: string, keys: string[]): Promise<void> {
  if (!isUuid(mediaId) || keys.length === 0) return;
  await getDb()
    .update(media)
    .set({
      withdrawingKeys: sql`nullif(array(select unnest(${media.withdrawingKeys})
        except select jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)), '{}'::text[])`,
    })
    .where(eq(media.id, mediaId));
}

/**
 * Clears a hidden or deleted item's derived keys once the files they name are deleted and purged,
 * in one statement, only while the item is still hidden or deleted and its keys are still the ones
 * withdrawn: an unhide since, and the files it made under keys of their own, are left as they are.
 * True if it cleared them.
 */
export async function clearWithdrawnFiles(
  mediaId: string,
  withdrawn: Partial<Record<DerivedVariant, string>>,
): Promise<boolean> {
  if (!isUuid(mediaId)) return false;
  const rows = await getDb()
    .update(media)
    .set({ derived: {} })
    .where(
      and(
        eq(media.id, mediaId),
        or(isNotNull(media.hiddenAt), isNotNull(media.deletedAt)),
        sql`${media.derived} = ${JSON.stringify(withdrawn)}::jsonb`,
      ),
    )
    .returning({ id: media.id });
  return rows.length > 0;
}

/** Where a sweep through unfinished uploads stopped: the last row it looked at. */
export type UploadCursor = { startedAt: Date; id: string };

export type UnfinishedUploadsPage = {
  /** Only uploads started more than this many minutes ago, by the database's clock. */
  startedMoreThanMinutesAgo: number;
  /** And within this many minutes. */
  startedWithinMinutes: number;
  cursor: UploadCursor | null;
  limit: number;
};

/**
 * The query behind unfinishedUploads, exported so a test can check its plan: the partial index of
 * unfinished uploads, read in its own order, so no sort. `status = 'uploading'` is a literal, so
 * Postgres can prove the index applies under a generic plan.
 */
export function unfinishedUploadsQuery({
  startedMoreThanMinutesAgo,
  startedWithinMinutes,
  cursor,
  limit,
}: UnfinishedUploadsPage) {
  return getDb()
    .select(uploadColumns)
    .from(media)
    .where(
      and(
        sql`${media.status} = 'uploading'`,
        isNotNull(media.multipartUploadId),
        sql`${media.startedAt} < now() - make_interval(mins => ${startedMoreThanMinutesAgo}::integer)`,
        sql`${media.startedAt} > now() - make_interval(mins => ${startedWithinMinutes}::integer)`,
        cursor
          ? or(gt(media.startedAt, cursor.startedAt), and(eq(media.startedAt, cursor.startedAt), gt(media.id, cursor.id)))
          : undefined,
      ),
    )
    .orderBy(asc(media.startedAt), asc(media.id))
    .limit(limit);
}

/**
 * Unfinished uploads that have a multipart upload and were started more than
 * `startedMoreThanMinutesAgo` but within `startedWithinMinutes` minutes ago, by the database's
 * clock, oldest first, after `cursor` when given: at most `limit` of them. The sweeper pages
 * through them a batch at a time, so one sweep is bounded and the next carries on.
 */
export async function unfinishedUploads(page: UnfinishedUploadsPage): Promise<UploadRow[]> {
  return unfinishedUploadsQuery(page);
}

export type NewUploadEvent = {
  guestId: string | null;
  mediaId: string | null;
  kind: UploadEventKind;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
};

/** Stores what a phone (or the upload API) reported, in one insert. */
export async function recordUploadEvents(events: NewUploadEvent[]): Promise<void> {
  if (events.length === 0) return;
  await getDb()
    .insert(uploadEvents)
    .values(
      events.map((event) => ({
        guestId: event.guestId,
        mediaId: event.mediaId,
        kind: event.kind,
        reason: event.reason ?? null,
        detail: event.detail ?? null,
      })),
    );
}
