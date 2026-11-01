import { sql, type SQL } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { EventId } from "@/content/wedding";
import { EVENT_IDS } from "@/lib/content/schema";
import type { DerivedVariant } from "@/lib/storage/keys";

export const rsvps = pgTable(
  "rsvps",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    fullName: text("full_name").notNull(),
    nameKey: text("name_key").notNull(),
    phone: text("phone").notNull(),
    phoneKey: text("phone_key").notNull(),
    email: text("email"),
    emailKey: text("email_key"),
    partySize: text("party_size").notNull(),
    answers: jsonb("answers").$type<Partial<Record<EventId, "yes" | "no">>>().notNull(),
    otherNames: text("other_names"),
    song: text("song"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    emailStatus: text("email_status").$type<"none" | "queued" | "sent" | "failed">().notNull().default("none"),
    /**
     * The reply's own guest, made with it, whose personal link only its confirmation carries
     * (Ruling CB); null for a reply sent before personal links. Nothing looks replies up by it, and
     * guests are never deleted, so it has no index.
     */
    guestId: uuid("guest_id").references((): AnyPgColumn => guests.id),
  },
  (table) => [
    index("rsvps_name_key_current_idx").on(table.nameKey).where(sql`${table.supersededAt} is null`),
    index("rsvps_email_key_idx").on(table.emailKey),
  ],
);

/**
 * Pairs of flagged replies the couple chose to keep both of ("Keep both"). One row per unordered
 * pair, stored with the smaller id first, so the pair stays unflagged whichever way round it comes.
 */
export const rsvpFlagDismissals = pgTable(
  "rsvp_flag_dismissals",
  {
    rsvpId: uuid("rsvp_id")
      .notNull()
      .references(() => rsvps.id, { onDelete: "cascade" }),
    otherRsvpId: uuid("other_rsvp_id")
      .notNull()
      .references(() => rsvps.id, { onDelete: "cascade" }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }).notNull().defaultNow(),
    dismissedBy: text("dismissed_by").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.rsvpId, table.otherRsvpId] }),
    check("rsvp_flag_dismissals_smaller_id_first", sql`${table.rsvpId} < ${table.otherRsvpId}`),
  ],
);

export const siteContent = pgTable(
  "site_content",
  {
    key: text("key").notNull(),
    version: integer("version").notNull(),
    value: jsonb("value").notNull(),
    savedAt: timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    savedBy: text("saved_by").notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.version] })],
);

/** The values a text column of the media tables may hold, checked by the database too. */
export const MEDIA_PURPOSES = ["album", "wish", "site"] as const;
export const MEDIA_FILE_KINDS = ["photo", "video", "audio"] as const;
export const MEDIA_STATUSES = ["uploading", "uploaded", "ready", "failed"] as const;
export const CONVERSION_STATES = ["none", "queued", "converting", "done", "failed"] as const;
export const WISH_KINDS = ["text", "voice", "video"] as const;
export const UPLOAD_EVENT_KINDS = ["part-retry", "failed", "resumed", "completed"] as const;

/**
 * The longest a guest's name may be, in characters (code points, as Postgres counts them): it
 * shows on every album tile and in emails. The same as a wish's signature.
 */
export const NAME_MAX_CHARACTERS = 80;
/** The longest an original's filename may be, in characters. */
export const FILENAME_MAX_CHARACTERS = 255;

/** A check that the column holds one of these values (constants of ours, never guest input). */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

/** A check that the text column holds at most this many characters (or is null). */
function atMost(column: AnyPgColumn, maxCharacters: number): SQL {
  return sql`char_length(${column}) <= ${sql.raw(String(maxCharacters))}`;
}

const withTimezone = { withTimezone: true } as const;

/** An album item's moderation state in the admin (Task 17), or none: visible, with nothing under way. */
export type AdminStateName = "removed" | "hidden" | "failed" | "processing" | "converting" | "queued";

/** The media columns the admin reads an item's state from: the table's own, or an alias's. */
export type AdminStateColumns = {
  removedByUploader: AnyPgColumn;
  hiddenAt: AnyPgColumn;
  status: AnyPgColumn;
  conversion: AnyPgColumn;
};

/**
 * An album item's state in the admin (Task 17): its tile's one badge, and the filter chip that lists
 * it. The first that applies: removed by its uploader, hidden by the couple, failed (its processing,
 * or a ready video's conversion), processing, converting, or queued for conversion; null for an
 * item with nothing to say. media_admin_state_idx is built on this very expression, and the admin's
 * queries compare it with literals, so Postgres matches the two and reads the index. Literals only:
 * a bound value here would stop the match.
 */
export function adminStateOf(columns: AdminStateColumns): SQL<AdminStateName | null> {
  const { removedByUploader, hiddenAt, status, conversion } = columns;
  return sql<AdminStateName | null>`(case when ${removedByUploader} then 'removed' when ${hiddenAt} is not null then 'hidden'
    when ${status} = 'failed' or (${status} = 'ready' and ${conversion} = 'failed') then 'failed'
    when ${status} = 'uploaded' then 'processing'
    when ${status} = 'ready' and ${conversion} = 'converting' then 'converting'
    when ${status} = 'ready' and ${conversion} = 'queued' then 'queued' end)`;
}

/**
 * What the admin's album lists (Task 17): album items that finished uploading (processing, ready or
 * failed), hidden and removed ones included, never a deleted tombstone. Every media_admin_* index's
 * condition, written as literals so a generic plan can prove the index applies.
 */
export function adminScopeOf(columns: { purpose: AnyPgColumn; deletedAt: AnyPgColumn; uploadedAt: AnyPgColumn }): SQL {
  return sql`${columns.purpose} = 'album' and ${columns.deletedAt} is null and ${columns.uploadedAt} is not null`;
}

/**
 * Each browser that has RSVPed or uploaded. Guests are never merged: a browser's cookie lists every
 * guest it knows (its own, plus any opened through a personal link).
 */
export const guests = pgTable(
  "guests",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    /** The name the guest typed (at most 80 characters), or null when they gave none. */
    displayName: text("display_name"),
    /** The personal link's secret: 32 random bytes in base64url. */
    linkToken: text("link_token").notNull().unique(),
    createdAt: timestamp("created_at", withTimezone).notNull().defaultNow(),
  },
  (table) => [check("guests_display_name_length", atMost(table.displayName, NAME_MAX_CHARACTERS))],
);

/**
 * One row per upload: album photos and videos, voice and video wishes, and the site's own photos.
 * A row is never removed once uploaded: "Delete permanently" leaves it as a tombstone (deleted_at).
 */
export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    purpose: text("purpose").$type<(typeof MEDIA_PURPOSES)[number]>().notNull(),
    kind: text("kind").$type<(typeof MEDIA_FILE_KINDS)[number]>().notNull(),
    /** The uploading guest; null for a site photo, which the couple upload from the admin. */
    guestId: uuid("guest_id").references(() => guests.id),
    /** The name shown with the item, as the uploader gave it (at most 80 characters); null for none. */
    uploaderName: text("uploader_name"),
    celebration: text("celebration").$type<EventId | "more">().notNull(),
    /** Set once the couple move an item, so re-processing never moves it back. */
    celebrationSetByAdmin: boolean("celebration_set_by_admin").notNull().default(false),

    /** `originals/<id>.<ext>` in the private bucket (originalKey). */
    originalKey: text("original_key").notNull().unique(),
    originalFilename: text("original_filename").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    contentType: text("content_type").notNull(),
    /** sha-256 of the size, the first MB and the last MB, so a re-picked file resumes its upload. */
    fileFingerprint: text("file_fingerprint"),
    multipartUploadId: text("multipart_upload_id"),
    /**
     * The size of the upload's parts, every one but the last, kept from its start: a file of 256 MiB
     * or more starts in 16 MiB parts, a smaller one in 8 MiB (partSizeFor). An upload started before
     * part sizes grew with the file is 8 MiB, the default, and carries on so.
     */
    partSizeBytes: integer("part_size_bytes").notNull().default(8 * 1024 * 1024),
    startedAt: timestamp("started_at", withTimezone).notNull().defaultNow(),
    /** When the upload completed, which starts the original's 30-day lock. */
    uploadedAt: timestamp("uploaded_at", withTimezone),
    capturedAt: timestamp("captured_at", withTimezone),
    /** When the item first became viewable: the album's order and cursor. */
    listedAt: timestamp("listed_at", withTimezone),

    status: text("status").$type<(typeof MEDIA_STATUSES)[number]>().notNull().default("uploading"),
    failureReason: text("failure_reason"),
    /**
     * The derived files' keys in the public bucket, by variant. Not empty only while those files may
     * be public: a hidden or deleted item keeps them until the visibility job has deleted and purged
     * them (the sweeper looks for any it hasn't), then they are cleared.
     */
    derived: jsonb("derived").$type<Partial<Record<DerivedVariant, string>>>().notNull().default({}),
    /**
     * Which making of the derived files is current, part of their keys' content hash: every unhide
     * raises it, so files made again never share a key with ones a hide is still deleting, or with
     * a URL a cache remembers as gone.
     */
    derivedGeneration: integer("derived_generation").notNull().default(0),
    /**
     * Storage keys being withdrawn: public files to delete and purge from Cloudflare, and, for
     * "Delete permanently", the original. Recorded before anything is deleted and cleared once all
     * is done, so a retry (or the sweeper) finishes what an attempt started, even for files no
     * listing shows any more. Null when nothing is pending.
     */
    withdrawingKeys: text("withdrawing_keys").array(),
    width: integer("width"),
    height: integer("height"),
    durationSeconds: real("duration_seconds"),
    /** The raw ThumbHash, base64; the client decodes it. */
    thumbhash: text("thumbhash"),
    averageColor: text("average_color"),
    videoCodec: text("video_codec"),
    /** Null until the video is probed. */
    browserPlayable: boolean("browser_playable"),

    conversion: text("conversion").$type<(typeof CONVERSION_STATES)[number]>().notNull().default("none"),
    conversionRequestedAt: timestamp("conversion_requested_at", withTimezone),
    /**
     * The lease on a `converting` conversion: the media.convert job (pg-boss keeps a job's id across
     * its retries) that claimed it, and so the only one that may carry it on (Ruling AQ).
     */
    conversionJobId: uuid("conversion_job_id"),
    /** Why a `failed` conversion failed, for its wording: "too-long", "corrupt", "processing-failed"… */
    conversionFailureReason: text("conversion_failure_reason"),
    highlight: boolean("highlight").notNull().default(false),

    hiddenAt: timestamp("hidden_at", withTimezone),
    /** Who hid it: an admin, or the guest who removed their own upload. */
    hiddenBy: text("hidden_by"),
    removedByUploader: boolean("removed_by_uploader").notNull().default(false),
    deletedAt: timestamp("deleted_at", withTimezone),
  },
  (table) => [
    // The album's pages and its new-items count: visible album items, newest listed first, the id
    // breaking ties. hidden_at and deleted_at are the index's condition, not leading columns:
    // Postgres doesn't treat "is null" as fixing a column's value, so with them as columns every
    // `order by listed_at desc, id desc` would sort. Descending with nulls first, Postgres's own
    // order for DESC, so a plain `desc()` reads it (drizzle-kit writes NULLS LAST otherwise).
    index("media_album_cursor_idx")
      .on(table.purpose, table.status, table.listedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.hiddenAt} is null and ${table.deletedAt} is null`),
    // "My uploads" (Task 15): one guest's own album items, newest listed first, the id breaking
    // ties, so a guest's pages read in order with no sort. Their uploaded and failed items, never
    // listed, come first of all (nulls first, as DESC reads them), where their own page finds them.
    index("media_album_mine_idx")
      .on(table.guestId, table.listedAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.purpose} = 'album' and ${table.hiddenAt} is null and ${table.deletedAt} is null`),
    // The album's counts by celebration and kind (the count line, and whether "More moments" has
    // anything), read from this index alone: only the moments everyone sees, two short columns each.
    index("media_album_stats_idx")
      .on(table.celebration, table.kind)
      .where(
        sql`${table.purpose} = 'album' and ${table.status} = 'ready' and ${table.hiddenAt} is null and ${table.deletedAt} is null and not ${table.removedByUploader}`,
      ),
    // How many guests shared the moments everyone sees (the home page's "from 180 of you", Task 20):
    // their guest ids, in order, so they are counted once each from this index alone, with no sort.
    index("media_album_sharers_idx")
      .on(table.guestId)
      .where(
        sql`${table.purpose} = 'album' and ${table.status} = 'ready' and ${table.hiddenAt} is null and ${table.deletedAt} is null and not ${table.removedByUploader}`,
      ),
    index("media_guest_id_idx").on(table.guestId),
    // The admin's album (Task 17), newest upload first, the id breaking ties, read without a sort.
    // Its trailing columns are what the admin filters a page on, so a page's ids and a search of
    // who shared it (uploader_name, case-insensitively) read this index alone, never the table:
    // the search walks it in order, so it never sorts either. Key columns, not INCLUDE ones, as
    // drizzle-kit writes no INCLUDE; past the first two they only ride along.
    index("media_admin_idx")
      .on(table.uploadedAt.desc().nullsFirst(), table.id.desc().nullsFirst(), table.uploaderName, table.celebration, table.kind)
      .where(adminScopeOf(table)),
    // The admin's counts: every chip's, per celebration and kind, in one grouped query that reads
    // this narrow index alone, already in its groups' order.
    index("media_admin_counts_idx")
      .on(table.celebration, table.kind, table.status, table.conversion, table.highlight, table.removedByUploader, table.hiddenAt)
      .where(adminScopeOf(table)),
    // The admin's album by celebration, "More moments" (a few dozen items) above all.
    index("media_admin_celebration_idx")
      .on(table.celebration, table.uploadedAt.desc().nullsFirst(), table.id.desc().nullsFirst(), table.kind)
      .where(adminScopeOf(table)),
    // The admin's state chips (Failed, Processing, Converting, Queued, Hidden, Removed): only the
    // items with a state, a few dozen, by state and then newest first. The columns the state is
    // read from ride along, so a chip's page reads the index alone.
    index("media_admin_state_idx")
      .on(
        adminStateOf(table),
        table.uploadedAt.desc().nullsFirst(),
        table.id.desc().nullsFirst(),
        table.uploaderName,
        table.celebration,
        table.kind,
        table.removedByUploader,
        table.hiddenAt,
        table.status,
        table.conversion,
      )
      .where(sql`${adminScopeOf(table)} and ${adminStateOf(table)} is not null`),
    // The admin's Highlights chip: the couple's favourites, newest first.
    index("media_admin_highlight_idx")
      .on(table.uploadedAt.desc().nullsFirst(), table.id.desc().nullsFirst(), table.uploaderName, table.celebration, table.kind)
      .where(sql`${adminScopeOf(table)} and ${table.highlight}`),
    // Re-picking a file finds its unfinished upload.
    index("media_resume_idx")
      .on(table.guestId, table.sizeBytes, table.fileFingerprint)
      .where(sql`${table.status} = 'uploading'`),
    // Ruling AX: a start of a file the couple hid is refused, whichever phone sends it. Only the
    // items they hid (not those a guest removed, nor the deleted): a handful at most.
    index("media_couple_hidden_idx")
      .on(table.fileFingerprint, table.sizeBytes)
      .where(sql`${table.hiddenAt} is not null and not ${table.removedByUploader} and ${table.deletedAt} is null`),
    // The media worker's sweeper (Task 8), every 10 minutes. Each holds only the rows in transit:
    // items waiting to be processed, conversions waiting, and unfinished uploads in the order the
    // sweeper pages through them.
    index("media_uploaded_idx").on(table.uploadedAt).where(sql`${table.status} = 'uploaded'`),
    index("media_conversion_queued_idx")
      .on(table.listedAt)
      .where(sql`${table.status} = 'ready' and ${table.conversion} = 'queued'`),
    // Conversions under way, which the sweeper checks for one whose job is gone (Ruling AQ).
    index("media_conversion_converting_idx")
      .on(table.listedAt)
      .where(sql`${table.status} = 'ready' and ${table.conversion} = 'converting'`),
    index("media_unfinished_upload_idx")
      .on(table.startedAt, table.id)
      .where(sql`${table.status} = 'uploading' and ${table.multipartUploadId} is not null`),
    // Hidden or deleted items whose public files no visibility job has withdrawn yet, and items with
    // a withdrawal under way (Task 12), which the sweeper sends a job for: a handful at most.
    index("media_withdrawal_idx")
      .on(table.id)
      .where(
        sql`((${table.hiddenAt} is not null or ${table.deletedAt} is not null) and ${table.derived} <> '{}'::jsonb) or ${table.withdrawingKeys} is not null`,
      ),
    check("media_purpose_check", oneOf(table.purpose, MEDIA_PURPOSES)),
    check("media_kind_check", oneOf(table.kind, MEDIA_FILE_KINDS)),
    check("media_status_check", oneOf(table.status, MEDIA_STATUSES)),
    check("media_conversion_check", oneOf(table.conversion, CONVERSION_STATES)),
    check("media_celebration_check", oneOf(table.celebration, [...EVENT_IDS, "more"])),
    check("media_uploader_name_length", atMost(table.uploaderName, NAME_MAX_CHARACTERS)),
    check("media_original_filename_length", atMost(table.originalFilename, FILENAME_MAX_CHARACTERS)),
    // A guest removing their own upload hides it as well (Task 12 sets both).
    check("media_removed_is_hidden", sql`not ${table.removedByUploader} or ${table.hiddenAt} is not null`),
  ],
);

/** The guestbook. A voice or video wish points at its recording, a media row of purpose "wish". */
export const wishes = pgTable(
  "wishes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    guestId: uuid("guest_id").references(() => guests.id),
    signedAs: text("signed_as").notNull(),
    kind: text("kind").$type<(typeof WISH_KINDS)[number]>().notNull(),
    message: text("message"),
    mediaId: uuid("media_id").references(() => media.id),
    createdAt: timestamp("created_at", withTimezone).notNull().defaultNow(),
    hiddenAt: timestamp("hidden_at", withTimezone),
    hiddenBy: text("hidden_by"),
    deletedAt: timestamp("deleted_at", withTimezone),
  },
  (table) => [
    // The wall: visible wishes, newest first.
    index("wishes_wall_idx")
      .on(table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.hiddenAt} is null and ${table.deletedAt} is null`),
    // The admin's Wishes (Task 17): every wish but the deleted, hidden ones too, newest first.
    index("wishes_admin_idx")
      .on(table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`${table.deletedAt} is null`),
    check("wishes_kind_check", oneOf(table.kind, WISH_KINDS)),
    check("wishes_text_has_message", sql`${table.kind} <> 'text' or ${table.message} is not null`),
    check("wishes_recording_has_media", sql`${table.kind} = 'text' or ${table.mediaId} is not null`),
    // A recording belongs to one wish.
    uniqueIndex("wishes_media_id_unique").on(table.mediaId).where(sql`${table.mediaId} is not null`),
  ],
);

/**
 * The site's own photos, by slot (the home hero, each story photo, each preview card…). Every save
 * adds a row; the newest row per slot is live, and an older one can be restored.
 */
export const siteImages = pgTable(
  "site_images",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    slot: text("slot").notNull(),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id),
    alt: text("alt").notNull(),
    /** The focal point, 0–1 from the left and the top, used as object-position. */
    focalX: real("focal_x").notNull().default(0.5),
    focalY: real("focal_y").notNull().default(0.5),
    /** The worker-drawn link-preview card, for preview slots, in the public bucket. */
    cardKey: text("card_key"),
    savedBy: text("saved_by").notNull(),
    savedAt: timestamp("saved_at", withTimezone).notNull().defaultNow(),
  },
  (table) => [
    index("site_images_slot_newest_idx").on(
      table.slot,
      table.savedAt.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    check(
      "site_images_focal_point_inside",
      sql`${table.focalX} between 0 and 1 and ${table.focalY} between 0 and 1`,
    ),
  ],
);

/** Failures and retries the phones report while uploading, for the admin's status page. */
export const uploadEvents = pgTable(
  "upload_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    guestId: uuid("guest_id").references(() => guests.id),
    // A cancelled upload's row is deleted; its events stay.
    mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
    kind: text("kind").$type<(typeof UPLOAD_EVENT_KINDS)[number]>().notNull(),
    reason: text("reason"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", withTimezone).notNull().defaultNow(),
  },
  (table) => [
    index("upload_events_created_at_idx").on(table.createdAt.desc().nullsFirst()),
    index("upload_events_media_id_idx").on(table.mediaId),
    check("upload_events_kind_check", oneOf(table.kind, UPLOAD_EVENT_KINDS)),
  ],
);

/** Switches and markers shared by the app and the worker, one JSON value per key (settings.ts). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", withTimezone).notNull().defaultNow(),
});
