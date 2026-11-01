import { Transform, type TransformCallback } from "node:stream";

/*
 * A HEIC's full-size JPEG goes to the public bucket, which holds no location (global constraints:
 * derived files carry none). heif-dec writes the HEIC's EXIF into the JPEG it makes, GPS and all, so
 * the JPEG streams through this filter on its way up: every segment before the picture's scan that
 * could carry anything about the guest or the place (EXIF and XMP in APP1, the rest of APP3 to
 * APP15 but Adobe's colour marker, comments) is dropped, and the only metadata written back is when
 * the photo was taken, so a phone's gallery files it on the right day. Nothing is decoded: the
 * picture's bytes pass through as they are. heif-dec has turned the pixels upright already, so the
 * EXIF's orientation going with the rest is right.
 */

/** A JPEG's metadata before its scan stays small: past this, the file is refused rather than held in memory. */
export const MAX_HEADER_BYTES = 16 * 1024 * 1024;

const START_OF_IMAGE = 0xd8;
const START_OF_SCAN = 0xda;
const JFIF = 0xe0; // APP0
const EXIF_OR_XMP = 0xe1; // APP1
const ICC_OR_OTHER = 0xe2; // APP2: an ICC profile is kept; anything else there (MPF's pointers) is not.
const ADOBE = 0xee; // APP14: how the colours are stored, which decoders need.
const COMMENT = 0xfe;

/** Whether a segment is kept: everything that describes the picture itself, nothing about who, where or with what. */
function keeps(marker: number, segment: Buffer): boolean {
  if (marker === EXIF_OR_XMP || marker === COMMENT) return false;
  if (marker === ICC_OR_OTHER) return segment.subarray(4, 16).toString("latin1") === "ICC_PROFILE\0";
  if (marker >= 0xe3 && marker <= 0xef) return marker === ADOBE;
  return true;
}

/** "2026:12:05 19:42:07" in UTC, which is Accra's time all year. */
function exifTime(moment: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${moment.getUTCFullYear()}:${pad(moment.getUTCMonth() + 1)}:${pad(moment.getUTCDate())} ${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}`;
}

/**
 * An APP1 segment holding only when the photo was taken: an EXIF block (big-endian TIFF) whose first
 * directory points to an EXIF directory with DateTimeOriginal and OffsetTimeOriginal ("+00:00").
 */
export function captureTimeExif(capturedAt: Date): Buffer {
  const dateTime = Buffer.from(`${exifTime(capturedAt)}\0`, "latin1"); // 20 bytes
  const offset = Buffer.from("+00:00\0", "latin1"); // 7 bytes
  const ifd0At = 8;
  const exifIfdAt = ifd0At + 2 + 12 + 4; // 26
  const dateTimeAt = exifIfdAt + 2 + 2 * 12 + 4; // 56
  const offsetAt = dateTimeAt + dateTime.length; // 76
  const tiff = Buffer.alloc(offsetAt + offset.length + 1); // padded to an even length
  tiff.write("MM", 0, "latin1");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0At, 4);
  // IFD0: one entry, the pointer to the EXIF directory (tag 0x8769, LONG).
  tiff.writeUInt16BE(1, ifd0At);
  tiff.writeUInt16BE(0x8769, ifd0At + 2);
  tiff.writeUInt16BE(4, ifd0At + 4);
  tiff.writeUInt32BE(1, ifd0At + 6);
  tiff.writeUInt32BE(exifIfdAt, ifd0At + 10);
  tiff.writeUInt32BE(0, ifd0At + 14);
  // The EXIF directory: DateTimeOriginal (0x9003) and OffsetTimeOriginal (0x9011), both ASCII.
  tiff.writeUInt16BE(2, exifIfdAt);
  const entry = (at: number, tag: number, value: Buffer, valueAt: number) => {
    tiff.writeUInt16BE(tag, at);
    tiff.writeUInt16BE(2, at + 2);
    tiff.writeUInt32BE(value.length, at + 4);
    tiff.writeUInt32BE(valueAt, at + 8);
  };
  entry(exifIfdAt + 2, 0x9003, dateTime, dateTimeAt);
  entry(exifIfdAt + 14, 0x9011, offset, offsetAt);
  tiff.writeUInt32BE(0, exifIfdAt + 26);
  dateTime.copy(tiff, dateTimeAt);
  offset.copy(tiff, offsetAt);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | EXIF_OR_XMP, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A stream that passes a JPEG through without its metadata, adding back only its capture time
 * (none when it is unknown). It holds only the header (the segments before the scan) in memory,
 * never the picture. Anything that isn't a JPEG, or a header past MAX_HEADER_BYTES, ends the stream
 * with an error.
 */
export function keepOnlyCaptureTime(capturedAt: Date | null): Transform {
  let header = Buffer.alloc(0);
  let passing = false;

  /** The header, filtered, once its scan begins at `scanAt`: the segments kept, the capture time after SOI (and JFIF). */
  function filteredHeader(scanAt: number): Buffer {
    const kept: Buffer[] = [header.subarray(0, 2)];
    let at = 2;
    let insertedAt: number | null = null;
    while (at < scanAt) {
      // Fill bytes (0xFF) may come before a marker: they go. Past them may be the scan itself, which
      // the stream passes on from scanAt.
      while (header[at + 1] === 0xff) at += 1;
      if (at >= scanAt) break;
      const marker = header[at + 1];
      const length = header.readUInt16BE(at + 2);
      const segment = header.subarray(at, at + 2 + length);
      // The capture time goes straight after SOI, or after JFIF's APP0, which must come first.
      if (insertedAt === null && marker !== JFIF) insertedAt = kept.length;
      if (keeps(marker, segment)) kept.push(segment);
      at += 2 + length;
    }
    if (capturedAt) kept.splice(insertedAt ?? kept.length, 0, captureTimeExif(capturedAt));
    return Buffer.concat(kept);
  }

  /** Where the scan starts, once the header holds it; null while more is needed. Throws for what isn't a JPEG. */
  function scanStart(): number | null {
    if (header.length < 2) return null;
    if (header[0] !== 0xff || header[1] !== START_OF_IMAGE) throw new Error("The decoded file is not a JPEG");
    let at = 2;
    while (at + 4 <= header.length) {
      if (header[at] !== 0xff) throw new Error("The decoded file is not a JPEG: a segment doesn't start with 0xFF");
      if (header[at + 1] === 0xff) {
        at += 1;
        continue;
      }
      const marker = header[at + 1];
      if (marker === START_OF_SCAN) return at;
      const length = header.readUInt16BE(at + 2);
      if (length < 2) throw new Error("The decoded file is not a JPEG: a segment is shorter than its own length");
      at += 2 + length;
    }
    return null;
  }

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      if (passing) {
        done(null, chunk);
        return;
      }
      header = Buffer.concat([header, chunk]);
      try {
        const scanAt = scanStart();
        if (scanAt === null) {
          if (header.length > MAX_HEADER_BYTES) throw new Error(`The JPEG's header is past ${MAX_HEADER_BYTES} bytes`);
          done();
          return;
        }
        passing = true;
        this.push(filteredHeader(scanAt));
        const rest = header.subarray(scanAt);
        header = Buffer.alloc(0);
        done(null, rest);
      } catch (error) {
        done(error as Error);
      }
    },
    flush(done: TransformCallback) {
      done(passing ? null : new Error("The decoded file is not a JPEG: it ended before its picture"));
    },
  });
}
