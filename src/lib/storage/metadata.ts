/**
 * The facts known when an upload starts, written once as the original's S3 metadata, so the album
 * can be rebuilt from R2 alone. S3 metadata travels as ASCII headers, so the uploader's name and
 * the original filename are URI-encoded; the guest id and start time are ASCII already.
 */
export type OriginalMetadata = {
  /** The uploading guest, or null for an upload that isn't a guest's (a site photo). */
  guestId: string | null;
  /** The name the uploader gave, or "" for none. */
  uploaderName: string;
  originalFilename: string;
  startedAt: Date;
};

/**
 * The most URI-encoded bytes the uploader's name and the original filename each keep. S3 and
 * MinIO refuse more than 2 KB of metadata (names plus values) with MetadataTooLarge, and encoding
 * makes a letter like Ɔ 6 bytes and an emoji 12, so longer ones are shortened (fitOriginalMetadata).
 */
export const METADATA_TEXT_BYTES = 800;

// With both texts at their limit and the longest guest id, the metadata comes to 1,800 bytes.
const METADATA_BUDGET_BYTES = 1_900;
const GUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

const NAMES = {
  guestId: "guest-id",
  uploaderName: "uploader-name",
  originalFilename: "original-filename",
  startedAt: "started-at",
} as const;

/** The longest start of `text` whose URI encoding fits in `maxBytes`, cut between code points. */
export function truncateEncoded(text: string, maxBytes: number): string {
  let kept = "";
  let bytes = 0;
  for (const codePoint of text.toWellFormed()) {
    bytes += encodeURIComponent(codePoint).length;
    if (bytes > maxBytes) break;
    kept += codePoint;
  }
  return kept;
}

/**
 * The metadata as it will be stored: the name and filename shortened to METADATA_TEXT_BYTES once
 * encoded. Show the uploader these values, since they are what the original keeps.
 */
export function fitOriginalMetadata(metadata: OriginalMetadata): OriginalMetadata {
  return {
    ...metadata,
    uploaderName: truncateEncoded(metadata.uploaderName, METADATA_TEXT_BYTES),
    originalFilename: truncateEncoded(metadata.originalFilename, METADATA_TEXT_BYTES),
  };
}

/** The S3 metadata headers for an original (names without the x-amz-meta- prefix). */
export function encodeOriginalMetadata(metadata: OriginalMetadata): Record<string, string> {
  const fitted = fitOriginalMetadata(metadata);
  const headers: Record<string, string> = { [NAMES.startedAt]: fitted.startedAt.toISOString() };
  if (fitted.guestId !== null) {
    if (!GUEST_ID.test(fitted.guestId)) {
      throw new Error(`Refusing ${JSON.stringify(fitted.guestId)} as a guest id in metadata`);
    }
    headers[NAMES.guestId] = fitted.guestId;
  }
  if (fitted.uploaderName) headers[NAMES.uploaderName] = encodeURIComponent(fitted.uploaderName);
  if (fitted.originalFilename) headers[NAMES.originalFilename] = encodeURIComponent(fitted.originalFilename);

  // S3 counts the bytes of every name and value. All are ASCII here, so a character is a byte.
  const bytes = Object.entries(headers).reduce(
    (total, [name, value]) => total + name.length + value.length,
    0,
  );
  if (bytes > METADATA_BUDGET_BYTES) {
    throw new Error(
      `The original's metadata is ${bytes} bytes, over its ${METADATA_BUDGET_BYTES}-byte budget`,
    );
  }
  return headers;
}

function decodeText(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    // Not written by encodeOriginalMetadata: keep it as it is.
    return value;
  }
}

/** Reads the metadata back, or null when the original wasn't started by startMultipart. */
export function decodeOriginalMetadata(headers: Record<string, string>): OriginalMetadata | null {
  const startedAt = new Date(headers[NAMES.startedAt] ?? "");
  if (Number.isNaN(startedAt.getTime())) return null;
  return {
    guestId: headers[NAMES.guestId] ?? null,
    uploaderName: decodeText(headers[NAMES.uploaderName]),
    originalFilename: decodeText(headers[NAMES.originalFilename]),
    startedAt,
  };
}
