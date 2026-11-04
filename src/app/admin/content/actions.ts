"use server";

import { refresh, updateTag } from "next/cache";
import { requireAdmin } from "@/lib/admin/access";
import {
  EDITOR_FIELDS,
  isSectionKey,
  isVersionNumber,
  MAX_SECTION_BYTES,
  newerVersionMessage,
  RELOAD,
  TOO_LONG,
  type SaveState,
} from "@/lib/admin/content";
import { prepareSection } from "@/lib/admin/prepare";
import { contentDefaults } from "@/lib/content/defaults";
import { CONTENT_TAG } from "@/lib/content/get";
import type { SectionKey } from "@/lib/content/schema";
import { restoreVersion, saveSection, type SaveResult } from "@/lib/content/store";
import { readPortraitMemberIds } from "@/lib/site-images/store";

// Reached by a direct POST as well as from the editor, so each action checks the couple first
// and trusts nothing it is sent. Both carry the version the page was showing as live: if anyone
// saved after that, nothing changes and the couple are told who did and when, so neither of them
// overwrites the other's change unseen.

function refused(message: string): SaveState {
  return { status: "error", errors: [message] };
}

/** A refusal: the newer version's saver and time, or the store's messages. */
function notSaved(result: SaveResult & { ok: false }, adminEmail: string): SaveState {
  return { status: "error", errors: result.newer ? [newerVersionMessage(result.newer, adminEmail)] : result.errors };
}

/** After a save: guests' pages read the new text on their next load, and this page re-renders. */
function saved(result: SaveResult & { ok: true }): SaveState {
  updateTag(CONTENT_TAG);
  refresh();
  return { status: "saved", errors: [], version: result.version };
}

/**
 * Saves the editor's form: the whole edited section as JSON (fields the form doesn't show come
 * back as they were loaded) and the version it was loaded from.
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

  // New wedding-party members never take the id of one with a portrait saved in Site photos.
  const portraitIds = key === "party" ? await readPortraitMemberIds() : [];
  const result = await saveSection(key, prepareSection(key, value, { portraitIds }), admin.email, {
    baseVersion: Number(baseVersion),
  });
  if (!result.ok) return notSaved(result, admin.email);
  return saved(result);
}

/**
 * Saves an earlier version again as the newest one; version 0 is the built-in text.
 * `baseVersion` is the version the page showed as live when the couple chose to restore.
 */
export async function restoreVersionAction(key: SectionKey, version: number, baseVersion: number): Promise<SaveState> {
  const admin = await requireAdmin();
  if (!isSectionKey(key) || !isVersionNumber(version) || !isVersionNumber(baseVersion)) return refused(RELOAD);

  const options = { baseVersion };
  const result =
    version === 0
      ? await saveSection(key, contentDefaults[key], admin.email, options)
      : await restoreVersion(key, version, admin.email, options);
  if (!result.ok) return notSaved(result, admin.email);
  return saved(result);
}
