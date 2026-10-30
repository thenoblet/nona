"use server";

import { refresh, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/admin/access";
import {
  EDITOR_FIELDS,
  isSectionKey,
  MAX_SECTION_BYTES,
  newerVersionMessage,
  prepareSection,
  TOO_LONG,
  type SaveState,
} from "@/lib/admin/content";
import { contentDefaults } from "@/lib/content/defaults";
import { CONTENT_TAG } from "@/lib/content/get";
import type { SectionKey } from "@/lib/content/schema";
import { restoreVersion, saveSection, type SaveResult } from "@/lib/content/store";

// Reached by a direct POST as well as from the editor, so each action checks the couple first
// and trusts nothing it is sent.

const RELOAD = "This page is out of date. Reload it and try again.";

function refused(message: string): SaveState {
  return { status: "error", errors: [message] };
}

/** After a save: guests' pages read the new text on their next load, and this page re-renders. */
function saved(result: SaveResult & { ok: true }): SaveState {
  updateTag(CONTENT_TAG);
  refresh();
  return { status: "saved", errors: [], version: result.version };
}

/**
 * Saves the editor's form: the whole edited section as JSON (fields the form doesn't show come
 * back as they were loaded) and the version it was loaded from. A save from an older version is
 * refused, so one of the couple never overwrites the other's change unseen.
 */
export async function saveSectionAction(key: SectionKey, _previous: SaveState, form: FormData): Promise<SaveState> {
  const admin = await requireAdmin();
  if (!isSectionKey(key)) return refused(RELOAD);

  const json = form.get(EDITOR_FIELDS.value);
  const baseVersion = form.get(EDITOR_FIELDS.baseVersion);
  if (typeof json !== "string" || typeof baseVersion !== "string" || !/^\d{1,9}$/.test(baseVersion)) {
    return refused(RELOAD);
  }
  if (Buffer.byteLength(json, "utf8") > MAX_SECTION_BYTES) {
    return refused(TOO_LONG);
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return refused(RELOAD);
  }

  const result = await saveSection(key, prepareSection(key, value), admin.email, { baseVersion: Number(baseVersion) });
  if (!result.ok) {
    return { status: "error", errors: result.newer ? [newerVersionMessage(result.newer, admin.email)] : result.errors };
  }
  return saved(result);
}

/** Saves an earlier version again as the newest one. Version 0 is the built-in text. */
export async function restoreVersionAction(key: SectionKey, version: number): Promise<SaveState> {
  const admin = await requireAdmin();
  if (!isSectionKey(key) || !Number.isSafeInteger(version) || version < 0) return refused(RELOAD);

  const result =
    version === 0
      ? await saveSection(key, contentDefaults[key], admin.email)
      : await restoreVersion(key, version, admin.email);
  if (!result.ok) return { status: "error", errors: result.errors };
  return saved(result);
}
