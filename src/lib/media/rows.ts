import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { EventId } from "@/lib/content/schema";
import { isUuid } from "@/lib/data/ids";
import { getDb } from "@/lib/db/client";
import {
  guests,
  media,
  uploadEvents,
  type MEDIA_FILE_KINDS,
  type MEDIA_PURPOSES,
  type MEDIA_STATUSES,
  type UPLOAD_EVENT_KINDS,
} from "@/lib/db/schema";

type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];
type MediaStatus = (typeof MEDIA_STATUSES)[number];
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
  const [row] = await getDb()
    .select({ id: media.id })
    .from(media)
    .where(
      and(
        eq(media.id, mediaId),
        isNull(media.hiddenAt),
        isNull(media.deletedAt),
        eq(media.removedByUploader, false),
      ),
    )
    .limit(1);
  return row !== undefined;
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
 * Marks a video's conversion failed for good. The video itself stays as it was, poster and all, and
 * a conversion already `done` stays done (a later re-conversion failing keeps the copy that works).
 * True if it changed the item.
 */
export async function markConversionFailed(mediaId: string): Promise<boolean> {
  const rows = await getDb()
    .update(media)
    .set({ conversion: "failed" })
    .where(and(eq(media.id, mediaId), sql`${media.conversion} <> 'done'`))
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
 * Unfinished uploads that have a multipart upload and were started between `startedAfter` and
 * `startedBefore`, oldest first, after `cursor` when given: at most `limit` of them. The sweeper
 * pages through them a batch at a time, so one sweep is bounded and the next carries on.
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
