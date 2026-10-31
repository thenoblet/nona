import "server-only";
import { and, desc, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { wishes } from "@/lib/db/schema";
import type { Wish, WishInput } from "./types";

type Row = typeof wishes.$inferSelect;

function toWish(row: Pick<Row, "id" | "kind" | "message" | "signedAs" | "createdAt">): Wish {
  return {
    id: row.id,
    kind: row.kind,
    ...(row.message === null ? {} : { message: row.message }),
    signedAs: row.signedAs,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The wishes wall: every wish not hidden or deleted, newest first. */
export async function listWishes(): Promise<Wish[]> {
  const rows = await getDb()
    .select({
      id: wishes.id,
      kind: wishes.kind,
      message: wishes.message,
      signedAs: wishes.signedAs,
      createdAt: wishes.createdAt,
    })
    .from(wishes)
    .where(and(isNull(wishes.hiddenAt), isNull(wishes.deletedAt)))
    .orderBy(desc(wishes.createdAt), desc(wishes.id));
  return rows.map(toWish);
}

/**
 * Saves a wish as sent. A written wish needs its message, and a voice or video one its recording
 * (mediaId): the database refuses either without it.
 */
export async function addWish(input: WishInput): Promise<Wish> {
  const [row] = await getDb()
    .insert(wishes)
    .values({
      kind: input.kind,
      message: input.message ?? null,
      signedAs: input.signedAs,
      guestId: input.guestId ?? null,
      mediaId: input.mediaId ?? null,
    })
    .returning();
  return toWish(row);
}
