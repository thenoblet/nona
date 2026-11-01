import "server-only";
import { accraDateTime } from "@/lib/accra";
import { BUILT_IN_CARD_PATHS } from "@/lib/preview-cards/routes";
import { publicUrl } from "@/lib/storage/keys";
import type { Focal } from "./focal";
import { builtinFocal, builtinPhoto } from "./photos";
import { slotDefinition, SLOT_GROUPS, type SlotDefinition, type SlotGroupId, type SlotShape } from "./slots";
import type { SiteImageRow, SitePhotoFile } from "./store";

/*
 * The admin's Site photos page (Task 19, gate B): each slot as the couple see it, from its saved
 * rows (newest first) and its built-in photo. Plain data, for the client editor.
 */

/**
 * A photo the editor shows: an address for the focal picker (about 640 px wide), one for the small
 * thumbnails and crop previews, and its size (for the picker's shape).
 */
export type EditorPhoto = { url: string; thumbUrl: string; width: number; height: number };

/** An earlier save the couple can restore, or the built-in photo. */
export type SlotVersion = {
  /** The row's id, or "builtin". */
  id: string;
  photo: EditorPhoto | null;
  /** "Saved 29 Oct, 21:14 by …", or "Built-in photo". */
  label: string;
  focal: Focal;
};

export type SlotView = {
  id: string;
  group: SlotGroupId;
  name: string;
  where: string;
  shape: SlotShape;
  /** Gate B's states: the built-in photo (edited or not), the couple's, or none at all. "Not saved" is the editor's own. */
  state: "builtin" | "yours" | "none";
  /** Whether a built-in photo's alt text or focal point were edited. */
  edited: boolean;
  /** Whether the slot has a built-in photo to go back to. */
  hasBuiltin: boolean;
  /** The live row's media id: the couple's photo, or null for the built-in one. */
  mediaId: string | null;
  photo: EditorPhoto | null;
  alt: string;
  focal: Focal;
  /** "29 Oct, 21:14" and who, for "Saved … by …"; null for the built-in photo unedited. */
  savedAt: string | null;
  savedBy: string | null;
  /**
   * A preview slot's card: the worker's once drawn (`stored`), else the build-time one; `drawn` is
   * false while the worker draws the live row's.
   */
  card: { url: string; drawn: boolean; stored: boolean } | null;
  versions: SlotVersion[];
};

/**
 * A site photo for the editor, from the worker's own sizes (never Next's optimiser): the 960 px one
 * for the picker (a 300 px picker at twice the pixels), the 480 px thumbnail for the rest.
 */
export function editorPhotoOf(file: SitePhotoFile | null): EditorPhoto | null {
  const key = file?.derived.medium ?? file?.derived.view;
  if (!file || file.status !== "ready" || !key || !file.width || !file.height) return null;
  return { url: publicUrl(key), thumbUrl: publicUrl(file.derived.thumb ?? key), width: file.width, height: file.height };
}

/** A built-in photo, one of the site's own files, through Next's image optimiser as the pages show it. */
function optimised(src: string, width: number): string {
  return `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=75`;
}

function builtinEditorPhoto(slotId: string): EditorPhoto | null {
  const builtin = builtinPhoto(slotId);
  if (!builtin) return null;
  const { image } = builtin;
  // In tests a static import is only its path.
  const src = typeof image === "string" ? image : image.src;
  const size = typeof image === "string" ? { width: 1200, height: 1600 } : { width: image.width, height: image.height };
  return { url: optimised(src, 640), thumbUrl: optimised(src, 256), ...size };
}

function savedLabel(row: SiteImageRow): string {
  return `${accraDateTime(row.savedAt.toISOString())} by ${row.savedBy}`;
}

/** One slot as the admin shows it, from its rows, newest first (the first is live). */
export function slotView(slot: SlotDefinition, rows: SiteImageRow[]): SlotView {
  const builtin = builtinPhoto(slot.id);
  const builtinPicture = builtinEditorPhoto(slot.id);
  const [live, ...earlier] = rows;
  const versions: SlotVersion[] = earlier.slice(0, 8).map((row) => ({
    id: row.id,
    photo: row.mediaId ? editorPhotoOf(row.photo) : builtinPicture,
    label: `${row.mediaId ? "Your photo" : "Built-in photo"} · ${savedLabel(row)}`,
    focal: row.focal,
  }));
  if (builtin && live) {
    versions.push({ id: "builtin", photo: builtinPicture, label: "Built-in photo, as it came", focal: builtinFocal(builtin) });
  }

  const card = slot.preview
    ? live?.cardKey
      ? { url: publicUrl(live.cardKey), drawn: true, stored: true }
      : { url: BUILT_IN_CARD_PATHS[slot.preview], drawn: !live, stored: false }
    : null;
  const base = {
    id: slot.id,
    group: slot.group,
    name: slot.name,
    where: slot.where,
    shape: slot.shape,
    hasBuiltin: builtin !== null,
    card,
    versions,
  };
  if (live?.mediaId) {
    return {
      ...base,
      state: "yours",
      edited: false,
      mediaId: live.mediaId,
      photo: editorPhotoOf(live.photo),
      alt: live.alt,
      focal: live.focal,
      savedAt: accraDateTime(live.savedAt.toISOString()),
      savedBy: live.savedBy,
    };
  }
  if (builtin) {
    const defaultFocal = builtinFocal(builtin);
    const edited =
      live !== undefined && (live.alt !== builtin.alt || live.focal.x !== defaultFocal.x || live.focal.y !== defaultFocal.y);
    return {
      ...base,
      state: "builtin",
      edited,
      mediaId: null,
      photo: builtinPicture,
      alt: live?.alt ?? builtin.alt,
      focal: live?.focal ?? defaultFocal,
      savedAt: live ? accraDateTime(live.savedAt.toISOString()) : null,
      savedBy: live?.savedBy ?? null,
    };
  }
  return { ...base, state: "none", edited: false, mediaId: null, photo: null, alt: "", focal: { x: 0.5, y: 0.5 }, savedAt: null, savedBy: null };
}

/** Every slot, in the admin's groups and order, from every saved row. */
export function slotViews(slots: SlotDefinition[], rows: SiteImageRow[]): SlotView[] {
  const rowsBySlot = new Map<string, SiteImageRow[]>();
  for (const row of rows) rowsBySlot.set(row.slot, [...(rowsBySlot.get(row.slot) ?? []), row]);
  return slots.map((slot) => slotView(slot, rowsBySlot.get(slot.id) ?? []));
}

/** One slot's view by its id, or null for an id that isn't a slot. */
export function slotViewOf(slotId: string, rows: SiteImageRow[], party: { id: string; name: string; role: string }[]): SlotView | null {
  const slot = slotDefinition(slotId, party);
  return slot ? slotView(slot, rows) : null;
}

export { SLOT_GROUPS };
