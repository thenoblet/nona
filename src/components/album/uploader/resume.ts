/*
 * What lets a file carry on rather than start again:
 * - its fingerprint (fingerprint.ts), which the upload API matches to find this guest's unfinished
 *   upload of the same file, renamed or not;
 * - the files this phone has asked the server to complete, and which upload each went to, kept in
 *   localStorage. When a complete's answer is lost (the connection drops as it comes back), the
 *   server has the file but the phone doesn't know: picked again, the file is asked about rather
 *   than sent twice (the API only resumes unfinished uploads, so a start would send it again).
 */

import type { StorageLike } from "./local-records";

export { fingerprintFile } from "./fingerprint";
export type { StorageLike } from "./local-records";

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
