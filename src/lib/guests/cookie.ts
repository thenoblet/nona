import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { createGuest, findGuestById, setGuestName } from "@/lib/data/guests";
import { isUuid } from "@/lib/data/ids";
import type { Guest } from "@/lib/data/types";
import { guestCookieSecret } from "@/lib/env";

export { personalLink, personalLinkOf } from "./personal-link";

/** The browser's own guest plus up to nine opened through personal links. */
export const MAX_GUEST_IDS = 10;

// Two years, as the spec asks. Chrome caps any cookie at 400 days, which still reaches past the
// wedding; making a guest or opening a personal link sets it again.
const TWO_YEARS_SECONDS = 2 * 365 * 24 * 60 * 60;

function signatureOf(joinedIds: string, secret: string): string {
  return createHmac("sha256", secret).update(joinedIds).digest("base64url");
}

/** The cookie's value for these ids: `<id,id…>.<HMAC-SHA256 in base64url>`, the browser's own id first. */
export function signGuestIds(ids: readonly string[]): string {
  const joinedIds = ids.join(",");
  return `${joinedIds}.${signatureOf(joinedIds, guestCookieSecret())}`;
}

/**
 * The ids a cookie value carries, the browser's own first. Anything the server wouldn't have signed
 * reads as none: a bad signature, an id that isn't a uuid, or more than ten ids.
 */
export function verifyGuestIds(value: string | undefined): string[] {
  // Read the secret first, so production without one fails on every use, not only for cookies.
  const secret = guestCookieSecret();
  if (!value) return [];
  const separator = value.lastIndexOf(".");
  if (separator === -1) return [];
  const joinedIds = value.slice(0, separator);
  const given = Buffer.from(value.slice(separator + 1));
  const expected = Buffer.from(signatureOf(joinedIds, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [];
  const ids = joinedIds.split(",");
  if (ids.length > MAX_GUEST_IDS || !ids.every((id) => isUuid(id))) return [];
  return ids;
}

function inProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * The name of the cookie that recognises a guest's browser, the one place it is named. Production
 * uses the __Host- prefix: the browser then takes it only with Secure, Path=/ and no Domain, so no
 * subdomain can set or read it. Local development runs over plain http, where a Secure cookie never
 * comes back, so it uses the bare name.
 */
export function guestCookieName(): string {
  return inProduction() ? "__Host-nona_guest" : "nona_guest";
}

async function writeGuestIds(ids: readonly string[]): Promise<void> {
  (await cookies()).set(guestCookieName(), signGuestIds(ids), {
    httpOnly: true,
    secure: inProduction(),
    sameSite: "lax",
    path: "/",
    maxAge: TWO_YEARS_SECONDS,
  });
}

/** Every guest this browser knows, its own first; none without a cookie or with a forged one. */
export async function readGuestIds(): Promise<string[]> {
  return verifyGuestIds((await cookies()).get(guestCookieName())?.value);
}

/** The browser's own guest id, which its uploads and rate limits use, or null. */
export async function ownGuestId(): Promise<string | null> {
  return (await readGuestIds())[0] ?? null;
}

/** The ids after remembering one: the own id first, the newest remembered next, no repeats, at most ten. */
function withRemembered(ids: readonly string[], guestId: string): string[] {
  if (ids.length === 0) return [guestId];
  const [ownId, ...remembered] = ids;
  if (guestId === ownId) return [...ids];
  return [ownId, guestId, ...remembered.filter((id) => id !== guestId)].slice(0, MAX_GUEST_IDS);
}

/**
 * The ids after taking a guest as the browser's own: it first, the previous own id next (now the
 * newest remembered), then the rest; no repeats, at most ten, dropping the oldest remembered.
 */
function withOwn(ids: readonly string[], guestId: string): string[] {
  return [guestId, ...ids.filter((id) => id !== guestId)].slice(0, MAX_GUEST_IDS);
}

/**
 * Makes a guest opened through a personal link this browser's own from now on (Ruling CG): its
 * uploads go with the link, while its earlier own guest is remembered first, so "My uploads" still
 * shows what it shared before. Nobody's uploads move and no guest is merged. Changes nothing when
 * the guest is already the browser's own. Only the confirm page's "Yes, that's me" may ask for it:
 * GET /my/[token] never adopts a guest (Ruling S). Route handlers and server actions only, since it
 * sets the cookie.
 */
export async function adoptGuest(guestId: string): Promise<string[]> {
  if (!isUuid(guestId)) throw new Error("adoptGuest needs a guest id");
  const known = await readGuestIds();
  if (known[0] === guestId) return known;
  const ids = withOwn(known, guestId);
  await writeGuestIds(ids);
  return ids;
}

/**
 * Adds a guest opened through a personal link to this browser's list, so "My uploads" shows theirs
 * too ("No, I'm someone else"). It never replaces the browser's own id; a browser without one takes
 * this guest as its own. Route handlers and server actions only, since it sets the cookie.
 */
export async function rememberGuest(guestId: string): Promise<string[]> {
  if (!isUuid(guestId)) throw new Error("rememberGuest needs a guest id");
  const ids = withRemembered(await readGuestIds(), guestId);
  await writeGuestIds(ids);
  return ids;
}

/**
 * The browser's own guest, made (and the cookie set) when it has none. A name replaces the stored
 * one; a blank or missing name leaves it, so a second phone that doesn't know it can't clear it.
 * Route handlers and server actions only, since it may set the cookie.
 *
 * Two calls at once from a browser without a cookie make two guests, and the last cookie wins, so
 * the uploader awaits one call (POST /api/guest) before its first upload starts.
 */
export async function ensureOwnGuest(displayName?: string | null): Promise<Guest> {
  const [ownId, ...remembered] = await readGuestIds();
  if (ownId) {
    const name = displayName?.trim();
    const own = name ? await setGuestName(ownId, name) : await findGuestById(ownId);
    if (own) return own;
    // The cookie names a guest the database no longer has (a restore from an older backup): make a
    // new own guest in its place, keeping the ones remembered through links.
  }
  const guest = await createGuest(displayName ?? null);
  await writeGuestIds([guest.id, ...remembered]);
  return guest;
}
