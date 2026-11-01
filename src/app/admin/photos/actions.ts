"use server";

import { refresh, updateTag } from "next/cache";
import { after } from "next/server";
import { requireAdmin } from "@/lib/admin/access";
import { isUuid } from "@/lib/data/ids";
import { findAdminItem } from "@/lib/media/admin-album";
import type { AdminItem, AdminWish } from "@/lib/media/admin-item";
import { lockWords } from "@/lib/media/admin-item";
import { findAdminWish } from "@/lib/media/admin-wishes";
import { ALBUM_CELEBRATIONS, type AlbumCelebration } from "@/lib/media/album-item";
import {
  ALBUM_SLIDES_TAG,
  deleteMediaPermanently,
  deleteWishPermanently,
  hideMedia,
  hideWish,
  moveMedia,
  retryProcessing,
  setConvertBacklog,
  setHighlight,
  setUploadsOpen,
  unhideMedia,
  unhideWish,
  type DeleteResult,
  type ModerationOptions,
  type ModerationResult,
  type RetryResult,
} from "@/lib/media/moderation";
import { isSlideshowDelay, saveSlideshowDelaySeconds } from "@/lib/media/slideshow-delay";

/*
 * The admin Photos page's actions (Task 17). Reached by a direct POST as well as from the page, so
 * each one checks the couple first (requireAdmin), refuses an id or a value that isn't one before
 * calling anything, then calls Task 12's own function. One that changes what guests see drops the
 * album's and the slideshow's cache (updateTag(ALBUM_SLIDES_TAG): the next request reads afresh);
 * then the page re-renders (refresh()), its counts and switches with it. A media action answers
 * with the item as it now is, for the page to show at once.
 */

/**
 * How long the follow-ups after the response (the manifest's R2 PUT, R2 deletions, jobs) may take
 * together, beside each R2 call's own 15 s deadline.
 */
const FOLLOW_UP_BUDGET_MILLISECONDS = 30_000;

/**
 * Moderation's options: its follow-ups run in after(), once the response has gone, under a budget
 * of their own. Never a request's signal: Next aborts that once the response is sent, which is when
 * the follow-ups run, so every one would fail.
 */
function followUps(): ModerationOptions {
  return { defer: after, signal: AbortSignal.timeout(FOLLOW_UP_BUDGET_MILLISECONDS) };
}

export type MediaActionResult = { ok: true; item: AdminItem | null } | { ok: false; error: string };
export type WishActionResult = { ok: true; wish: AdminWish | null } | { ok: false; error: string };
export type SwitchResult = { ok: true } | { ok: false; error: string };

const ITEM_GONE = "That photo or video isn't in the album any more. Reload to see the album as it is.";
const WISH_GONE = "That wish isn't there any more. Reload to see the wishes as they are.";
const NOT_A_CELEBRATION = "Choose one of the celebrations, or More moments.";
const RELOAD = "Reload the page and try again.";
const NOT_A_DELAY = "Use a whole number of seconds from 0 to 900.";

function isId(value: unknown): value is string {
  return typeof value === "string" && isUuid(value);
}

/** After a media action: the item as it now is, the caches its change touched, and the page again. */
async function afterMediaAction(
  mediaId: string,
  result: ModerationResult | RetryResult | DeleteResult,
  guestsSeeIt: boolean,
): Promise<MediaActionResult> {
  if (result.ok && guestsSeeIt) updateTag(ALBUM_SLIDES_TAG);
  refresh();
  if (result.ok) return { ok: true, item: await findAdminItem(mediaId) };
  switch (result.reason) {
    case "locked":
      return { ok: false, error: `Can be deleted permanently from ${lockWords(result.allowedFrom.toISOString())}. Hide it if it has to go now.` };
    case "nothing-to-retry":
      return { ok: false, error: "There's nothing to retry: it isn't failed any more." };
    case "not-uploaded":
      return { ok: false, error: "It never finished uploading, so there's nothing to delete." };
    default:
      return { ok: false, error: ITEM_GONE };
  }
}

/** "Hide from the album": guests stop seeing it at once, the TV too. No confirm: Undo and Unhide reverse it. */
export async function hideMediaAction(mediaId: string): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId)) return { ok: false, error: ITEM_GONE };
  return afterMediaAction(mediaId, await hideMedia(mediaId, { admin: admin.email }, followUps()), true);
}

/** "Unhide" (and a hide's Undo): back in the album for everyone once its files are made again. */
export async function unhideMediaAction(mediaId: string): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId)) return { ok: false, error: ITEM_GONE };
  return afterMediaAction(mediaId, await unhideMedia(mediaId, admin.email, followUps()), true);
}

/** "Move": to another celebration, or More moments; processing never moves it back. */
export async function moveMediaAction(mediaId: string, celebration: string): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId)) return { ok: false, error: ITEM_GONE };
  if (typeof celebration !== "string" || !(ALBUM_CELEBRATIONS as readonly string[]).includes(celebration)) {
    return { ok: false, error: NOT_A_CELEBRATION };
  }
  return afterMediaAction(mediaId, await moveMedia(mediaId, celebration as AlbumCelebration, admin.email, followUps()), true);
}

/** "Highlight": a star for the couple's favourites; a highlighted video is converted first. Guests see no change. */
export async function setHighlightAction(mediaId: string, on: boolean): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId) || typeof on !== "boolean") return { ok: false, error: ITEM_GONE };
  return afterMediaAction(mediaId, await setHighlight(mediaId, on, admin.email, followUps()), false);
}

/** "Retry processing": a failed item's processing, or a ready video's failed conversion, again. */
export async function retryProcessingAction(mediaId: string): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId)) return { ok: false, error: ITEM_GONE };
  return afterMediaAction(mediaId, await retryProcessing(mediaId, admin.email, followUps()), false);
}

/** "Delete permanently", after its confirm: only once the original's 30-day lock has passed. */
export async function deleteMediaAction(mediaId: string): Promise<MediaActionResult> {
  const admin = await requireAdmin();
  if (!isId(mediaId)) return { ok: false, error: ITEM_GONE };
  return afterMediaAction(mediaId, await deleteMediaPermanently(mediaId, admin.email, followUps()), true);
}

/** After a wish action: the wish as it now is, the caches, and the page again. */
async function afterWishAction(wishId: string, result: ModerationResult | DeleteResult): Promise<WishActionResult> {
  if (result.ok) updateTag(ALBUM_SLIDES_TAG);
  refresh();
  if (result.ok) return { ok: true, wish: await findAdminWish(wishId) };
  if (result.reason === "locked") {
    return { ok: false, error: `Can be deleted permanently from ${lockWords(result.allowedFrom.toISOString())}. Hide it if it has to go now.` };
  }
  return { ok: false, error: WISH_GONE };
}

/** "Hide" a wish: off the wall at once, its recording with it. */
export async function hideWishAction(wishId: string): Promise<WishActionResult> {
  const admin = await requireAdmin();
  if (!isId(wishId)) return { ok: false, error: WISH_GONE };
  return afterWishAction(wishId, await hideWish(wishId, admin.email, followUps()));
}

/** "Unhide" a wish: back on the wall. */
export async function unhideWishAction(wishId: string): Promise<WishActionResult> {
  const admin = await requireAdmin();
  if (!isId(wishId)) return { ok: false, error: WISH_GONE };
  return afterWishAction(wishId, await unhideWish(wishId, admin.email, followUps()));
}

/** "Delete permanently" a wish, after its confirm: a written one at once, a recording once its lock has passed. */
export async function deleteWishAction(wishId: string): Promise<WishActionResult> {
  const admin = await requireAdmin();
  if (!isId(wishId)) return { ok: false, error: WISH_GONE };
  return afterWishAction(wishId, await deleteWishPermanently(wishId, admin.email, followUps()));
}

/** The Uploads switch, after its confirm: closing gives uploads already sending 24 hours to finish. */
export async function setUploadsOpenAction(open: boolean): Promise<SwitchResult> {
  const admin = await requireAdmin();
  if (typeof open !== "boolean") return { ok: false, error: RELOAD };
  await setUploadsOpen(open, admin.email);
  refresh();
  return { ok: true };
}

/** The Convert backlog videos switch, after its confirm; the worker follows within its 30 s heartbeat. */
export async function setConvertBacklogAction(on: boolean): Promise<SwitchResult> {
  const admin = await requireAdmin();
  if (typeof on !== "boolean") return { ok: false, error: RELOAD };
  await setConvertBacklog(on, admin.email);
  refresh();
  return { ok: true };
}

/** Saves the TV delay, 0 to 900 seconds; the slideshow's cache drops, so the TV follows on its next poll. */
export async function saveSlideshowDelayAction(seconds: number): Promise<SwitchResult> {
  await requireAdmin();
  if (!isSlideshowDelay(seconds)) return { ok: false, error: NOT_A_DELAY };
  await saveSlideshowDelaySeconds(seconds);
  updateTag(ALBUM_SLIDES_TAG);
  refresh();
  return { ok: true };
}
