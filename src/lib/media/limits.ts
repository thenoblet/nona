import type { MEDIA_FILE_KINDS } from "@/lib/db/schema";

/*
 * What a guest may upload, checked before any bytes are sent. The upload API refuses anything
 * else with plain words; the worker re-checks the real bytes (magic numbers) and decodes the file,
 * so a file that lies here still ends `failed`. Pure: no I/O and no imports beyond types, so the
 * worker can bundle it too (limits.test.ts checks).
 */

type MediaFileKind = (typeof MEDIA_FILE_KINDS)[number];

/** What a guest's upload is for. Site photos (Task 19) go through the admin, not these checks. */
export type GuestUploadPurpose = "album" | "wish";

const MEBIBYTE = 1024 * 1024;

/**
 * The most each kind of upload may be, in binary units (a "50 MB" photo is 50 MiB): a little
 * more generous than decimal, so a file a phone shows as 50 MB is never refused.
 */
export const SIZE_LIMITS = {
  photo: 50 * MEBIBYTE,
  video: 2 * 1024 * MEBIBYTE,
  voiceWish: 20 * MEBIBYTE,
  videoWish: 200 * MEBIBYTE,
} as const;

/** Every upload goes up in parts of 8 MiB, the last one smaller. */
export const PART_SIZE_BYTES = 8 * MEBIBYTE;

/** How many parts a file of this size takes. */
export function partCount(sizeBytes: number): number {
  return Math.ceil(sizeBytes / PART_SIZE_BYTES);
}

/** The size of one part of a file this size: 8 MiB, or what is left for the last one. */
export function partSizeOf(sizeBytes: number, partNumber: number): number {
  return Math.min(PART_SIZE_BYTES, sizeBytes - (partNumber - 1) * PART_SIZE_BYTES);
}

/** The most parts any upload has: a 2 GB video's. */
export const MAX_PART_COUNT = partCount(SIZE_LIMITS.video);

/**
 * The declared content types each upload accepts, each with the filename extensions that agree
 * with it, the first being the one the key takes when the filename's doesn't agree. Nothing else
 * is accepted: no SVG (it can carry scripts), no application/* or text/*, no empty type.
 */
const PHOTO_TYPES: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg", "jpe", "jfif"],
  "image/png": ["png"],
  "image/heic": ["heic", "heif", "hif"],
  "image/heif": ["heif", "heic", "hif"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "image/avif": ["avif"],
};

const VIDEO_TYPES: Record<string, readonly string[]> = {
  "video/mp4": ["mp4", "m4v"],
  "video/quicktime": ["mov", "qt"],
  "video/webm": ["webm"],
  "video/3gpp": ["3gp"],
  "video/x-matroska": ["mkv"],
};

const VOICE_TYPES: Record<string, readonly string[]> = {
  "audio/mp4": ["m4a", "mp4"],
  "audio/m4a": ["m4a"],
  "audio/x-m4a": ["m4a"],
  "audio/aac": ["aac"],
  "audio/mpeg": ["mp3"],
  "audio/webm": ["webm", "weba"],
  "audio/ogg": ["ogg", "oga", "opus"],
  "audio/wav": ["wav"],
  "audio/x-wav": ["wav"],
  "audio/amr": ["amr"],
  "audio/3gpp": ["3gp"],
};

/**
 * The album gallery picker's `accept` (layer 1 of the type checks: a convenience, not a check):
 * the album's photo and video types, with their extensions for pickers that go by name. The
 * camera's pickers keep image/* and video/*, which phones need to open the camera itself, and
 * which the camera can only answer with a photo or a video.
 */
export const ALBUM_PICKER_ACCEPT = [
  ...Object.keys(PHOTO_TYPES),
  ...Object.keys(VIDEO_TYPES),
  ...new Set([...Object.values(PHOTO_TYPES), ...Object.values(VIDEO_TYPES)].flat().map((extension) => `.${extension}`)),
].join(",");

type Accepted = { kind: MediaFileKind; extensions: readonly string[]; maxBytes: number; tooLarge: string };

function accepting(
  types: Record<string, readonly string[]>,
  kind: MediaFileKind,
  maxBytes: number,
  tooLarge: string,
): Record<string, Accepted> {
  return Object.fromEntries(
    Object.entries(types).map(([contentType, extensions]) => [contentType, { kind, extensions, maxBytes, tooLarge }]),
  );
}

const ACCEPTED: Record<GuestUploadPurpose, Record<string, Accepted>> = {
  album: {
    ...accepting(PHOTO_TYPES, "photo", SIZE_LIMITS.photo, "This photo is over 50 MB, the most the album takes."),
    ...accepting(
      VIDEO_TYPES,
      "video",
      SIZE_LIMITS.video,
      "This video is over 2 GB, the most the album takes. Please send a shorter clip.",
    ),
  },
  wish: {
    ...accepting(VOICE_TYPES, "audio", SIZE_LIMITS.voiceWish, "This voice message is over 20 MB, the most a wish takes."),
    ...accepting(VIDEO_TYPES, "video", SIZE_LIMITS.videoWish, "This video message is over 200 MB, the most a wish takes."),
  },
};

const UNSUPPORTED: Record<GuestUploadPurpose, string> = {
  album: "Only photos and videos can be shared here.",
  wish: "Only voice and video recordings can be sent here.",
};

/** Extensions refused outright, whatever type the file declares: documents, pages and programs. */
const REFUSED_EXTENSIONS = new Set([
  "pdf",
  "svg",
  "svgz",
  "html",
  "htm",
  "xhtml",
  "js",
  "mjs",
  "exe",
  "msi",
  "bat",
  "cmd",
  "scr",
  "apk",
  "jar",
]);

// What a phone that doesn't know HEIC sends for it; accepted only by a .heic or .heif name.
const UNKNOWN_BINARY = "application/octet-stream";
const HEIC_EXTENSIONS = new Set(["heic", "heif"]);

// A key's extension: lower-case letters and digits, one to five of them.
const SAFE_EXTENSION = /^[a-z0-9]{1,5}$/;

/** A declared content type as compared: lower case, trimmed, without parameters such as codecs. */
export function normalizeContentType(declared: string): string {
  return declared.split(";")[0].trim().toLowerCase();
}

/** The filename's extension in lower case, or "": the text after the last dot of its last segment. */
function filenameExtension(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot === -1 ? "" : basename.slice(dot + 1).toLowerCase();
}

export type UploadRefusal = "unsupported-type" | "empty-file" | "too-large";

export type UploadCheck =
  | {
      ok: true;
      kind: MediaFileKind;
      /** The type the original is stored with. */
      contentType: string;
      /** The extension for the original's key. */
      extension: string;
      partCount: number;
    }
  | { ok: false; error: UploadRefusal; message: string };

/**
 * Whether a guest may upload this file, before any bytes are sent: an accepted type for the
 * purpose, a name that isn't a document or program, and a size from 1 byte to the kind's limit.
 * Accepted, it says how to store it: the kind, the content type, the key's extension (the
 * filename's when it agrees with the type, else the type's own) and the number of parts.
 */
export function checkUpload(upload: {
  purpose: GuestUploadPurpose;
  filename: string;
  contentType: string;
  size: number;
}): UploadCheck {
  const { purpose, size } = upload;
  const unsupported = { ok: false, error: "unsupported-type", message: UNSUPPORTED[purpose] } as const;
  const extension = filenameExtension(upload.filename);
  if (REFUSED_EXTENSIONS.has(extension)) return unsupported;

  let contentType = normalizeContentType(upload.contentType);
  if (contentType === UNKNOWN_BINARY && purpose === "album" && HEIC_EXTENSIONS.has(extension)) {
    contentType = "image/heic";
  }
  const accepted = Object.hasOwn(ACCEPTED[purpose], contentType) ? ACCEPTED[purpose][contentType] : undefined;
  if (!accepted) return unsupported;

  if (size <= 0) {
    return { ok: false, error: "empty-file", message: "This file is empty, so there's nothing to send. Please choose another." };
  }
  if (size > accepted.maxBytes) return { ok: false, error: "too-large", message: accepted.tooLarge };

  const agrees = SAFE_EXTENSION.test(extension) && accepted.extensions.includes(extension);
  return {
    ok: true,
    kind: accepted.kind,
    contentType,
    extension: agrees ? extension : accepted.extensions[0],
    partCount: partCount(size),
  };
}
