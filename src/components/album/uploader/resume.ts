/*
 * What lets a file carry on rather than start again:
 * - its fingerprint, which the upload API matches to find this guest's unfinished upload of the same
 *   file, renamed or not: a sha-256 of its size, first MB and last MB, read in two 1 MB slices, so a
 *   2 GB video is never read into memory;
 * - the files this phone has asked the server to complete, and which upload each went to, kept in
 *   localStorage. When a complete's answer is lost (the connection drops as it comes back), the
 *   server has the file but the phone doesn't know: picked again, the file is asked about rather
 *   than sent twice (the API only resumes unfinished uploads, so a start would send it again).
 */

const MEBIBYTE = 1024 * 1024;

async function bytesOf(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

/** The file's fingerprint, as the upload API takes it: sha-256 hex of `<size>:`, the first MB and the last MB. */
export async function fingerprintFile(file: Blob): Promise<string> {
  const { size } = file;
  const head = await bytesOf(file, 0, Math.min(MEBIBYTE, size));
  const tail = await bytesOf(file, Math.max(0, size - MEBIBYTE), size);
  const label = new TextEncoder().encode(`${size}:`);
  const joined = new Uint8Array(label.length + head.length + tail.length);
  joined.set(label, 0);
  joined.set(head, label.length);
  joined.set(tail, label.length + head.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SentFiles = {
  /** The upload this file went to, when this phone asked the server to complete it; else null. */
  find(size: number, fingerprint: string): string | null;
  remember(size: number, fingerprint: string, mediaId: string): void;
  forget(size: number, fingerprint: string): void;
};

const SENT_FILES_KEY = "nona:sent-files";
const MAX_SENT_FILES = 400;

type Entry = { mediaId: string; at: number };

/** The files this phone has sent, in `storage` (localStorage); nothing is remembered without it. */
export function createSentFiles(storage: StorageLike | null): SentFiles {
  const keyOf = (size: number, fingerprint: string) => `${size}:${fingerprint}`;

  function read(): Record<string, Entry> {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(SENT_FILES_KEY) ?? "{}");
      return saved && typeof saved === "object" ? (saved as Record<string, Entry>) : {};
    } catch {
      return {};
    }
  }

  function write(entries: Record<string, Entry>): void {
    try {
      storage?.setItem(SENT_FILES_KEY, JSON.stringify(entries));
    } catch {
      // Full or blocked: this file just isn't remembered.
    }
  }

  return {
    find(size, fingerprint) {
      const entry = read()[keyOf(size, fingerprint)];
      return typeof entry?.mediaId === "string" ? entry.mediaId : null;
    },
    remember(size, fingerprint, mediaId) {
      const entries = read();
      // Newest last; a file sent again moves to the end.
      delete entries[keyOf(size, fingerprint)];
      entries[keyOf(size, fingerprint)] = { mediaId, at: Date.now() };
      const keys = Object.keys(entries);
      for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_SENT_FILES))) delete entries[oldest];
      write(entries);
    },
    forget(size, fingerprint) {
      const entries = read();
      if (!(keyOf(size, fingerprint) in entries)) return;
      delete entries[keyOf(size, fingerprint)];
      write(entries);
    },
  };
}
