import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { isUuid } from "@/lib/data/ids";

/*
 * Where a page of the admin's lists ends (Task 17): the last row's time, to the microsecond, and its
 * id, which breaks ties. The admin's album pages by uploaded_at and its wishes by created_at.
 */

/** A page's end: a time to the microsecond, in UTC ("2026-12-05T18:00:00.123456Z"), and the row's id. */
export type TimeCursor = { at: string; id: string };

// To the microsecond: a JavaScript Date keeps only milliseconds, which would make a cursor fall
// between two rows written in the same millisecond.
const TIME_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** The cursor as a page carries it: opaque, URL-safe. */
export function encodeTimeCursor(cursor: TimeCursor): string {
  return Buffer.from(`${cursor.at}~${cursor.id}`).toString("base64url");
}

/** The cursor a page sent, or null when it isn't one this server made. */
export function decodeTimeCursor(value: string | null | undefined): TimeCursor | null {
  if (!value || value.length > 200) return null;
  const [at, id, ...rest] = Buffer.from(value, "base64url").toString("utf8").split("~");
  if (rest.length > 0 || !at || !id || !TIME_TEXT.test(at) || !isUuid(id)) return null;
  return { at, id: id.toLowerCase() };
}

/** A time column as a cursor carries it, to the microsecond, in UTC. */
export function microsecondText(column: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
