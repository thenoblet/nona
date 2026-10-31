import "server-only";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { guests } from "@/lib/db/schema";
import { isUuid } from "./ids";
// The name as kept: printable, trimmed and cut to 80 characters (text.ts).
import { cleanName } from "./text";
import type { Guest } from "./types";

// 32 random bytes in base64url, without padding.
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function toGuest(row: typeof guests.$inferSelect): Guest {
  return {
    id: row.id,
    displayName: row.displayName,
    linkToken: row.linkToken,
    createdAt: row.createdAt.toISOString(),
  };
}

/** A new guest with their own personal-link token: 32 random bytes, URL-safe as it is. */
export async function createGuest(displayName: string | null): Promise<Guest> {
  const [row] = await getDb()
    .insert(guests)
    .values({ displayName: cleanName(displayName), linkToken: randomBytes(32).toString("base64url") })
    .returning();
  return toGuest(row);
}

/** The guest a personal link belongs to, or null. Anything not shaped like a token finds no one. */
export async function findGuestByToken(token: string): Promise<Guest | null> {
  if (!LINK_TOKEN.test(token)) return null;
  const [row] = await getDb().select().from(guests).where(eq(guests.linkToken, token)).limit(1);
  return row ? toGuest(row) : null;
}

/** The guest with this id, or null. Anything that isn't a uuid finds no one. */
export async function findGuestById(id: string): Promise<Guest | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb().select().from(guests).where(eq(guests.id, id)).limit(1);
  return row ? toGuest(row) : null;
}

/** Changes the guest's name (trimmed, cut to 80 characters; empty clears it). Null when there is no such guest. */
export async function setGuestName(id: string, name: string | null): Promise<Guest | null> {
  if (!isUuid(id)) return null;
  const [row] = await getDb()
    .update(guests)
    .set({ displayName: cleanName(name) })
    .where(eq(guests.id, id))
    .returning();
  return row ? toGuest(row) : null;
}
