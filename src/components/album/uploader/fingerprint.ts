/*
 * A picked file's fingerprint, which the upload API matches to carry on this guest's unfinished
 * upload of the same file, renamed or not: a sha-256 of its size, first MB and last MB, read in two
 * 1 MB slices, so a 2 GB video is never read into memory.
 *
 * Read the moment the file is picked (Ruling BA), alongside the guest call rather than after it: a
 * file a phone's app is still finishing (WhatsApp, a cloud download) can change on disk after the
 * pick, and Chrome's File then refuses every read (NotReadableError, as the File API asks). The
 * sooner it is read, the smaller that window. Reads go a few files at a time, so a 60-photo batch
 * doesn't hold 120 MB of slices at once. Small: it ships with the album page, so a pick reads its
 * files before the uploader has even loaded.
 */

const MEBIBYTE = 1024 * 1024;

/** Picked files read at once. */
export const FINGERPRINTS_AT_ONCE = 3;
/** A read that takes longer than this (a file still downloading from the cloud) stops holding its place in line. */
const SLOW_READ_MILLISECONDS = 5_000;

/** Which of the fingerprint's two reads it was: the file's first MB or its last. */
export type FileRead = "head" | "tail";

/** A read of the file that failed: the browser's own error (its name and words kept), and which read it was. */
export class FileReadError extends Error {
  readonly read: FileRead;

  constructor(read: FileRead, cause: unknown) {
    const original = cause as { name?: unknown; message?: unknown } | null;
    super(typeof original?.message === "string" ? original.message : "The file could not be read", { cause });
    this.name = typeof original?.name === "string" ? original.name : "Error";
    this.read = read;
  }
}

async function bytesOf(file: Blob, start: number, end: number, read: FileRead): Promise<Uint8Array> {
  try {
    return new Uint8Array(await file.slice(start, end).arrayBuffer());
  } catch (error) {
    throw new FileReadError(read, error);
  }
}

/** The file's fingerprint, as the upload API takes it: sha-256 hex of `<size>:`, the first MB and the last MB. */
export async function fingerprintFile(file: Blob): Promise<string> {
  const { size } = file;
  const head = await bytesOf(file, 0, Math.min(MEBIBYTE, size), "head");
  const tail = await bytesOf(file, Math.max(0, size - MEBIBYTE), size, "tail");
  const label = new TextEncoder().encode(`${size}:`);
  const joined = new Uint8Array(label.length + head.length + tail.length);
  joined.set(label, 0);
  joined.set(head, label.length);
  joined.set(tail, label.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Each picked file's read, kept until it has an answer, so the uploader takes the same one.
const reads = new WeakMap<Blob, Promise<string>>();
const waiting: (() => void)[] = [];
let readsGoingOn = 0;

/** Waits for a place among the reads going on; returns what gives it back (once, however often called). */
async function placeInLine(): Promise<() => void> {
  if (readsGoingOn >= FINGERPRINTS_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
  readsGoingOn += 1;
  let given = false;
  return () => {
    if (given) return;
    given = true;
    readsGoingOn -= 1;
    waiting.shift()?.();
  };
}

/**
 * The file's fingerprint, read once however often it is asked for: at the pick, then by the
 * uploader. A failed read isn't kept, so asking again reads again.
 */
export function readOnPick(file: Blob): Promise<string> {
  const known = reads.get(file);
  if (known) return known;
  const fingerprinting = (async () => {
    const leave = await placeInLine();
    // A slow read lets the next file in, rather than holding up the batch behind it.
    const slow = setTimeout(leave, SLOW_READ_MILLISECONDS);
    try {
      return await fingerprintFile(file);
    } finally {
      clearTimeout(slow);
      leave();
    }
  })();
  reads.set(file, fingerprinting);
  fingerprinting.catch(() => {
    if (reads.get(file) === fingerprinting) reads.delete(file);
  });
  return fingerprinting;
}
