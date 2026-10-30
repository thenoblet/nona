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
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { EventId } from "@/content/wedding";
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

/** A check that the column holds one of these values (constants of ours, never guest input). */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}

const withTimezone = { withTimezone: true } as const;

/**
 * Each browser that has RSVPed or uploaded. Guests are never merged: a browser's cookie lists every
 * guest it knows (its own, plus any opened through a personal link).
 */
export const guests = pgTable("guests", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  /** The name the guest typed, or null when they gave none. */
  displayName: text("display_name"),
  /** The personal link's secret: 32 random bytes in base64url. */
  linkToken: text("link_token").notNull().unique(),
  createdAt: timestamp("created_at", withTimezone).notNull().defaultNow(),
});

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
    /** The name shown with the item, as the uploader gave it; null for none. */
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
    startedAt: timestamp("started_at", withTimezone).notNull().defaultNow(),
    /** When the upload completed, which starts the original's 30-day lock. */
    uploadedAt: timestamp("uploaded_at", withTimezone),
    capturedAt: timestamp("captured_at", withTimezone),
    /** When the item first became viewable: the album's order and cursor. */
    listedAt: timestamp("listed_at", withTimezone),

    status: text("status").$type<(typeof MEDIA_STATUSES)[number]>().notNull().default("uploading"),
    failureReason: text("failure_reason"),
    /** The derived files' keys in the public bucket, by variant. */
    derived: jsonb("derived").$type<Partial<Record<DerivedVariant, string>>>().notNull().default({}),
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
    index("media_guest_id_idx").on(table.guestId),
    // Re-picking a file finds its unfinished upload.
    index("media_resume_idx")
      .on(table.guestId, table.sizeBytes, table.fileFingerprint)
      .where(sql`${table.status} = 'uploading'`),
    check("media_purpose_check", oneOf(table.purpose, MEDIA_PURPOSES)),
    check("media_kind_check", oneOf(table.kind, MEDIA_FILE_KINDS)),
    check("media_status_check", oneOf(table.status, MEDIA_STATUSES)),
    check("media_conversion_check", oneOf(table.conversion, CONVERSION_STATES)),
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
    check("wishes_kind_check", oneOf(table.kind, WISH_KINDS)),
    check("wishes_text_has_message", sql`${table.kind} <> 'text' or ${table.message} is not null`),
    check("wishes_recording_has_media", sql`${table.kind} = 'text' or ${table.mediaId} is not null`),
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
