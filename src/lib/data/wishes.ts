import "server-only";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { clockTime } from "@/lib/media/album-item";
import { publicUrl } from "@/lib/storage/keys";
import { isUuid } from "./ids";
import type { RecordedWishInput, TextWishInput, Wish, WishKind, WishMediaState } from "./types";

/*
 * The guestbook. A written wish is its words; a voice or video wish names its recording, a media row
 * of purpose `wish` that the guest's phone uploaded and the worker makes ready (media.wish).
 *
 * Ruling BR: a recorded wish shows to everyone once its recording is ready; while it is being made
 * ready, or once that has failed, only to the guest who sent it (by the guest cookie), so they can
 * see it landed; and a hidden or deleted one never shows. An orphan recording (an upload that
 * completed but whose wish never came) has no wish, so it is on no wall and in no list.
 */

/** The media kind each recorded wish's recording must be. */
const RECORDING_KIND: Record<Exclude<WishKind, "text">, "audio" | "video"> = { voice: "audio", video: "video" };

/** The most recordings one batched read answers (GET /api/wishes/media). */
export const MAX_WISH_MEDIA_PER_READ = 50;

const wishColumns = {
  id: wishes.id,
  kind: wishes.kind,
  message: wishes.message,
  signedAs: wishes.signedAs,
  createdAt: wishes.createdAt,
  guestId: wishes.guestId,
  mediaId: wishes.mediaId,
};

/** What the wall reads of a recording, by its primary key. */
const recordingColumns = {
  id: media.id,
  status: media.status,
  derived: media.derived,
  durationSeconds: media.durationSeconds,
  width: media.width,
  height: media.height,
  visible: sql<boolean>`${media.hiddenAt} is null and ${media.deletedAt} is null and not ${media.removedByUploader}`,
};

type WishRow = {
  id: string;
  kind: WishKind;
  message: string | null;
  signedAs: string;
  createdAt: Date;
  guestId: string | null;
  mediaId: string | null;
};

type RecordingRow = {
  id: string;
  status: "uploading" | "uploaded" | "ready" | "failed";
  derived: Partial<Record<string, string>>;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  visible: boolean;
};

/** The file a ready recording plays: a voice note's M4A, a video message's MP4. */
function playedKey(kind: WishKind, recording: RecordingRow): string | undefined {
  return kind === "voice" ? recording.derived.audio : recording.derived.video;
}

/** A wish as the wall has it, with its recording (as its row was read) when it has one. */
function toWish(row: WishRow, recording: RecordingRow | null): Wish {
  const wish: Wish = {
    id: row.id,
    kind: row.kind,
    ...(row.message === null || row.kind !== "text" ? {} : { message: row.message }),
    signedAs: row.signedAs,
    createdAt: row.createdAt.toISOString(),
  };
  if (row.kind === "text" || !row.mediaId || !recording) return wish;
  const played = playedKey(row.kind, recording);
  if (recording.status === "ready" && played) {
    const poster = recording.derived["poster-view"];
    return {
      ...wish,
      ...(recording.durationSeconds === null ? {} : { duration: clockTime(recording.durationSeconds) }),
      recording: { url: publicUrl(played), poster: poster ? publicUrl(poster) : null, width: recording.width, height: recording.height },
    };
  }
  return { ...wish, pending: { mediaId: row.mediaId, state: recording.status === "failed" ? "failed" : "processing" } };
}

/** Recordings no one has hidden, deleted or removed (isVisible's condition). */
const visibleRecording = sql`${media.hiddenAt} is null and ${media.deletedAt} is null and not ${media.removedByUploader}`;

/**
 * The wall's wishes: every one not hidden or deleted, newest first (the order of wishes_wall_idx).
 * Exported so a test can check its plan.
 */
export function wallQuery() {
  return getDb()
    .select(wishColumns)
    .from(wishes)
    .where(and(isNull(wishes.hiddenAt), isNull(wishes.deletedAt)))
    .orderBy(desc(wishes.createdAt), desc(wishes.id));
}

/**
 * The recordings of these wishes, by primary key: never a scan of the media table, whatever the
 * album holds. Exported so a test can check its plan.
 */
export function recordingsQuery(mediaIds: readonly string[]) {
  return getDb()
    .select(recordingColumns)
    .from(media)
    .where(and(inArray(media.id, [...mediaIds]), sql`${media.purpose} = 'wish'`));
}

/**
 * Whether the wall shows this wish to a browser that knows these guests (Ruling BR): a written
 * wish, a ready recording with its file, to everyone; one still being made ready, or failed, to its
 * sender only; one whose recording is hidden, deleted or gone, to no one.
 */
function shownTo(wish: Wish, row: WishRow, recording: RecordingRow | null, viewerGuestIds: readonly string[]): boolean {
  if (wish.kind === "text") return true;
  if (!recording?.visible || recording.status === "uploading") return false;
  if (wish.recording) return true;
  return row.guestId !== null && viewerGuestIds.includes(row.guestId);
}

/**
 * The wishes wall as this browser sees it, newest first: every written wish and ready recording not
 * hidden or deleted, and the recordings this browser's guests sent that are still being made ready
 * (`pending`), or failed (Ruling BR). A ready recording whose file isn't there shows as being made
 * ready, to its sender only. Two indexed reads: the wishes, then their recordings by primary key.
 */
export async function listWishes(viewerGuestIds: readonly string[] = []): Promise<Wish[]> {
  const rows = (await wallQuery()) as WishRow[];
  const mediaIds = rows.flatMap((row) => (row.kind !== "text" && row.mediaId ? [row.mediaId] : []));
  const recordings = new Map(
    mediaIds.length === 0 ? [] : ((await recordingsQuery(mediaIds)) as RecordingRow[]).map((recording) => [recording.id, recording]),
  );
  return rows.flatMap((row) => {
    const recording = row.mediaId ? (recordings.get(row.mediaId) ?? null) : null;
    const wish = toWish(row, recording);
    return shownTo(wish, row, recording, viewerGuestIds) ? [wish] : [];
  });
}

/**
 * Saves a written wish, from the browser's own guest when it has one. The database refuses one
 * without its words.
 */
export function addWish(input: TextWishInput): Promise<Wish>;
/**
 * Saves a recorded wish, linking its recording, or refuses (null). It links only a recording that is:
 * an upload of purpose `wish` (never an album item); one of this browser's guests' (`guestIds`, the
 * cookie's); of the wish's kind (a voice wish's audio, a video wish's video); completed (uploaded,
 * ready, or failed, which its sender is then shown); and not hidden, deleted or removed. A recording
 * belongs to one wish (wishes_media_id_unique): asked again for the same one (a send whose answer
 * was lost), it answers the wish it already has when that is this browser's; any other is refused.
 * One statement, so two sends at once make one wish. The wish takes the recording's guest.
 */
export function addWish(input: RecordedWishInput): Promise<Wish | null>;
export async function addWish(input: TextWishInput | RecordedWishInput): Promise<Wish | null> {
  if (input.kind === "text") {
    const [row] = await getDb()
      .insert(wishes)
      .values({ kind: "text", message: input.message ?? null, signedAs: input.signedAs, guestId: input.guestId ?? null })
      .returning(wishColumns);
    return toWish(row, null);
  }
  if (!input.mediaId) throw new TypeError("A recorded wish needs its recording");
  const owners = input.guestIds.filter((guestId) => isUuid(guestId));
  if (!isUuid(input.mediaId) || owners.length === 0) return null;
  const mediaId = input.mediaId.toLowerCase();
  const recordingKind = RECORDING_KIND[input.kind];
  const ownerList = sql.join(
    owners.map((guestId) => sql`${guestId}::uuid`),
    sql`, `,
  );
  const inserted = await getDb().execute<{ id: string }>(sql`
    insert into wishes (kind, signed_as, guest_id, media_id)
    select ${input.kind}, ${input.signedAs}, ${media.guestId}, ${media.id}
    from ${media}
    where ${media.id} = ${mediaId}::uuid
      and ${media.purpose} = 'wish'
      and ${media.kind} = ${recordingKind}
      and ${media.guestId} in (${ownerList})
      and ${media.status} in ('uploaded', 'ready', 'failed')
      and ${media.uploadedAt} is not null
      and ${visibleRecording}
    on conflict (media_id) where media_id is not null do nothing
    returning id`);
  const wishId = inserted[0]?.id ?? (await sameSendAgain(mediaId, owners, input.kind));
  if (!wishId) return null;
  const [row] = (await getDb().select(wishColumns).from(wishes).where(eq(wishes.id, wishId)).limit(1)) as WishRow[];
  const [recording] = (await recordingsQuery([mediaId])) as RecordingRow[];
  return row ? toWish(row, recording ?? null) : null;
}

/** The wish this browser already made of the recording, for a send asked again; null for any other. */
async function sameSendAgain(mediaId: string, owners: readonly string[], kind: WishKind): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: wishes.id })
    .from(wishes)
    .where(and(eq(wishes.mediaId, mediaId), eq(wishes.kind, kind), inArray(wishes.guestId, [...owners]), isNull(wishes.hiddenAt), isNull(wishes.deletedAt)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The batched read behind the sender's "Getting your wish ready…" (Ruling BU): each named recording
 * that is one of this browser's guests' own, linked to a wish that isn't hidden or deleted, and
 * itself visible, with how far it has got. Anything else (another guest's, hidden, deleted, an
 * album item, an orphan) is left out, the same as one that doesn't exist. One query on the primary
 * key; at most MAX_WISH_MEDIA_PER_READ ids, any that aren't one skipped.
 */
export async function findOwnWishMedia(
  mediaIds: readonly string[],
  viewerGuestIds: readonly string[],
): Promise<{ id: string; state: WishMediaState }[]> {
  const ids = [...new Set(mediaIds.filter((id) => isUuid(id)).map((id) => id.toLowerCase()))].slice(0, MAX_WISH_MEDIA_PER_READ);
  const owners = viewerGuestIds.filter((guestId) => isUuid(guestId));
  if (ids.length === 0 || owners.length === 0) return [];
  const rows = await getDb()
    .select({ id: media.id, status: media.status })
    .from(media)
    .innerJoin(wishes, eq(wishes.mediaId, media.id))
    .where(
      and(
        inArray(media.id, ids),
        sql`${media.purpose} = 'wish'`,
        inArray(media.guestId, owners),
        sql`${media.status} in ('uploaded', 'ready', 'failed')`,
        visibleRecording,
        isNull(wishes.hiddenAt),
        isNull(wishes.deletedAt),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    state: row.status === "ready" ? "ready" : row.status === "failed" ? "failed" : "processing",
  }));
}
