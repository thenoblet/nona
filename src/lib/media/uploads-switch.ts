import "server-only";
import { getSettings } from "@/lib/data/settings";
import type { MEDIA_PURPOSES } from "@/lib/db/schema";
import type { UploadRow } from "./rows";

/*
 * The couple's uploads switch, and what it allows. Every upload route checks it, and so does the
 * media worker's sweeper before it finishes an upload (Ruling Z): once closed, an album upload goes
 * no further, by the guest or the server, past its 24 hours of grace. The worker bundles this file,
 * so it reaches nothing from next/.
 */

type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

/** How long after the couple close uploads an upload started before the close may still finish. */
export const UPLOADS_GRACE_MILLISECONDS = 24 * 60 * 60 * 1000;

/** The couple's uploads switch: open, or closed since `closedAt`. */
export type UploadsSwitch = { open: boolean; closedAt: Date | null };

/** For uploads the switch doesn't govern (wishes). */
export const UPLOADS_ALWAYS_OPEN: UploadsSwitch = { open: true, closedAt: null };

/** The uploads switch, in one query. Fails closed: nothing saved, or anything but true, is closed. */
export async function readUploadsSwitch(): Promise<UploadsSwitch> {
  const saved = await getSettings({ uploads_open: false, uploads_closed_at: null });
  const closedAt = typeof saved.uploads_closed_at === "string" ? new Date(saved.uploads_closed_at) : null;
  return {
    open: saved.uploads_open === true,
    closedAt: closedAt && !Number.isNaN(closedAt.getTime()) ? closedAt : null,
  };
}

/** Whether a new upload for this purpose may start: wishes always, album uploads while open. */
export function mayStartUpload(purpose: MediaPurpose, uploads: UploadsSwitch): boolean {
  return purpose !== "album" || uploads.open;
}

/**
 * Whether an unfinished upload may go on (resume, presign, complete): wishes always; album uploads
 * while open, or, once closed, one started before the close and only for 24 hours after it.
 */
export function mayContinueUpload(
  upload: Pick<UploadRow, "purpose" | "startedAt">,
  uploads: UploadsSwitch,
  now: Date = new Date(),
): boolean {
  if (upload.purpose !== "album" || uploads.open) return true;
  if (!uploads.closedAt) return false;
  const closedAt = uploads.closedAt.getTime();
  return upload.startedAt.getTime() < closedAt && now.getTime() < closedAt + UPLOADS_GRACE_MILLISECONDS;
}
