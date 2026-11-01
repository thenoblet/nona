import { sizeWords, type AlbumItem } from "@/lib/media/album-item";
import type { PlaybackChoice } from "./playback";

/*
 * The viewer's Download menu and Save to Photos (gate B, 1b and 1c). Noblet, 30 and 31 Oct: the
 * original stays downloadable for everyone, as it was shared.
 */

export type DownloadVariant = "original" | "converted" | "jpeg";

export type DownloadChoice = {
  variant: DownloadVariant;
  label: string;
  /** What it is and how big, before a guest spends their data. */
  sub: string;
  disabled: boolean;
  /** Made on its first request (a HEIC's JPEG): "Making the JPEG…" while it is. */
  prepare: boolean;
};

/**
 * The menu, the choice most guests want first:
 * - a photo: "Original photo";
 * - an iPhone photo: "As JPEG" (made on its first request), then "Original file";
 * - a video: "For your phone" (the conversion, else the clean copy; waiting while neither is
 *   made), then "Original file".
 */
export function downloadChoices(item: AlbumItem): DownloadChoice[] {
  const { type, bytes } = item.original;
  const choice = (variant: DownloadVariant, label: string, sub: string, extra: Partial<DownloadChoice> = {}): DownloadChoice => ({
    variant,
    label,
    sub,
    disabled: false,
    prepare: false,
    ...extra,
  });
  if (item.video) {
    const { converted, copy, codec } = item.video;
    const phoneVersion = converted
      ? choice("converted", "For your phone", "MP4 · plays on any phone")
      : copy
        ? choice("converted", "For your phone", codec === "h264" ? "MP4 · plays on any phone" : "MP4 · for newer phones")
        : choice("converted", "For your phone", "Getting it ready…", { disabled: true });
    return [phoneVersion, choice("original", "Original file", `${type} · ${sizeWords(bytes)} · as ${item.mine ? "you" : (item.by ?? "they")} shared it`)];
  }
  if (item.heic) {
    return [
      choice("jpeg", "As JPEG", "Opens on any phone", { prepare: true }),
      choice("original", "Original file", `${type} · ${sizeWords(bytes)} · iPhone format`),
    ];
  }
  return [choice("original", "Original photo", `${type} · ${sizeWords(bytes)} · full size`)];
}

/** What Save to Photos fetches: through the download route (a photo), or a public URL (a video's version). */
export type Savable =
  | { variant: DownloadVariant; extension: string; type: string }
  | { url: string; extension: string; type: string };

const PHOTO_TYPES: Record<string, string> = { jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };

/**
 * What Save to Photos saves: what the menu leads with, as this phone shows it. A photo's original
 * (an iPhone photo's JPEG); a video's version this phone plays, and while that is being made, none
 * (Noblet's pick: it waits, and never saves the original).
 */
export function savable(item: AlbumItem, playback: PlaybackChoice | null): Savable | null {
  if (item.kind === "video") {
    if (playback?.kind === "converted" || playback?.kind === "copy") return { url: playback.url, extension: "mp4", type: "video/mp4" };
    return null;
  }
  if (item.heic) return { variant: "jpeg", extension: "jpg", type: "image/jpeg" };
  const extension = item.original.type.toLowerCase() === "jpeg" ? "jpg" : item.original.type.toLowerCase();
  return { variant: "original", extension, type: PHOTO_TYPES[extension] ?? "image/jpeg" };
}
