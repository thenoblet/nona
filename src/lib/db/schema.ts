import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EventId } from "@/content/wedding";

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
  (t) => [
    index("rsvps_name_key_current_idx").on(t.nameKey).where(sql`${t.supersededAt} is null`),
    index("rsvps_email_key_idx").on(t.emailKey),
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
  (t) => [primaryKey({ columns: [t.key, t.version] })],
);
