"use server";

import { updateTag } from "next/cache";
import { after } from "next/server";
import { requireAdmin } from "@/lib/admin/access";
import { getSiteContent } from "@/lib/content/get";
import { isUuid } from "@/lib/data/ids";
import { SITE_IMAGE_ALT_MAX_CHARACTERS } from "@/lib/db/schema";
import { slotViewOf, type SlotView } from "@/lib/site-images/admin";
import { sendCardJobOrLog } from "@/lib/site-images/cards";
import { isFocal, type Focal } from "@/lib/site-images/focal";
import { builtinFocal, builtinPhoto } from "@/lib/site-images/photos";
import { isSlotId, previewOf, SITE_IMAGES_TAG } from "@/lib/site-images/slots";
import {
  readSiteImages,
  readSiteImage,
  readSiteUpload,
  restoreSiteImage,
  saveSiteImage,
  type SiteImageRow,
} from "@/lib/site-images/store";

/*
 * The admin's Site photos actions (Task 19). Reached by a direct POST as well as from the page, so
 * each checks the couple first (requireAdmin) and trusts nothing it is sent: the slot must be one,
 * the photo one of the couple's own site photos that the worker has made ready, the focal point
 * inside the photo, and the alt text there (gate B: required to save). A save or restore updates
 * the guest pages' cache (updateTag), so the next request shows it, and a preview slot's card is
 * sent to the worker after the response. Each answers with the slot as it now is.
 */

export type SlotActionResult = { ok: true; slot: SlotView } | { ok: false; error: string; field?: "alt" };

const RELOAD = "Reload the page and try again.";
const ALT_MISSING = "Describe the photo before saving.";
const ALT_TOO_LONG = `Keep the description under ${SITE_IMAGE_ALT_MAX_CHARACTERS} characters.`;

/** The slot as it now is, for the page to show at once. */
async function currentSlot(slot: string): Promise<SlotActionResult> {
  const [rows, { party }] = await Promise.all([readSiteImages(slot), getSiteContent()]);
  const view = slotViewOf(slot, rows, party);
  return view ? { ok: true, slot: view } : { ok: false, error: RELOAD };
}

/** After a save or restore: guest pages read afresh, and a preview slot's card goes to the worker. */
async function afterChange(row: SiteImageRow): Promise<SlotActionResult> {
  updateTag(SITE_IMAGES_TAG);
  if (previewOf(row.slot)) after(() => sendCardJobOrLog(row.id));
  return currentSlot(row.slot);
}

export type SaveSlotInput = {
  slot: string;
  /** The couple's uploaded photo, or null to edit the built-in photo's alt text and focal point. */
  mediaId: string | null;
  alt: string;
  focal: Focal;
};

/** "Save": the slot shows this photo, alt text and focal point from now on. */
export async function saveSlotAction(input: SaveSlotInput): Promise<SlotActionResult> {
  const admin = await requireAdmin();
  const { slot, mediaId, focal } = input ?? ({} as SaveSlotInput);
  if (!isSlotId(slot) || !isFocal(focal)) return { ok: false, error: RELOAD };
  const alt = typeof input.alt === "string" ? input.alt.trim() : "";
  if (alt === "") return { ok: false, field: "alt", error: ALT_MISSING };
  if ([...alt].length > SITE_IMAGE_ALT_MAX_CHARACTERS) return { ok: false, field: "alt", error: ALT_TOO_LONG };

  if (mediaId === null) {
    if (!builtinPhoto(slot)) return { ok: false, error: "Add a photo first: this one has no built-in photo." };
  } else {
    if (typeof mediaId !== "string" || !isUuid(mediaId)) return { ok: false, error: RELOAD };
    const upload = await readSiteUpload(mediaId);
    if (!upload) return { ok: false, error: "That photo isn't there any more. Choose it again." };
    if (upload.status === "failed") return { ok: false, error: "That photo couldn't be read. Try another." };
    if (upload.status !== "ready") return { ok: false, error: "That photo is still being prepared. Save again in a moment." };
  }
  const saved = await saveSiteImage({ slot, mediaId, alt, focal, savedBy: admin.email });
  return afterChange(saved);
}

/** "Use this one" on an earlier photo (or the built-in photo, `"builtin"`): it is saved again as the newest. */
export async function restoreSlotAction(slot: string, version: string): Promise<SlotActionResult> {
  const admin = await requireAdmin();
  if (!isSlotId(slot) || typeof version !== "string") return { ok: false, error: RELOAD };
  if (version === "builtin") {
    const builtin = builtinPhoto(slot);
    if (!builtin) return { ok: false, error: RELOAD };
    const saved = await saveSiteImage({ slot, mediaId: null, alt: builtin.alt, focal: builtinFocal(builtin), savedBy: admin.email });
    return afterChange(saved);
  }
  const earlier = await readSiteImage(version);
  if (!earlier || earlier.slot !== slot) return { ok: false, error: RELOAD };
  const restored = await restoreSiteImage(earlier.id, admin.email);
  if (!restored) return { ok: false, error: RELOAD };
  return afterChange(restored);
}

/**
 * The slot as it is now: the page asks every few seconds while the worker draws a card. Once the
 * card is drawn (its address differs from `knownCardUrl`, the one the page has), the guest pages'
 * cache is updated too, so the pages' og:image points at it from the next request.
 */
export async function slotStateAction(slot: string, knownCardUrl: string | null = null): Promise<SlotActionResult> {
  await requireAdmin();
  if (!isSlotId(slot)) return { ok: false, error: RELOAD };
  const result = await currentSlot(slot);
  if (result.ok && result.slot.card?.stored && result.slot.card.url !== knownCardUrl) updateTag(SITE_IMAGES_TAG);
  return result;
}
