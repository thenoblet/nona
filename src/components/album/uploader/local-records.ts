/*
 * What this phone remembers of its uploads between visits, in localStorage, small enough to ship
 * with the album page (which reads it before the uploader loads):
 * - the uploads it started and hasn't finished, so once the couple close sharing, during the 24
 *   hours an unfinished upload may still finish, the page can offer to finish them;
 * - the Cancels it couldn't get the server to answer, sent again on the next visit, so a guest's
 *   Cancel is never dropped.
 * Storage blocked or full only means nothing is remembered.
 */

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STARTED_KEY = "nona:started-files";
const PENDING_CANCELS_KEY = "nona:pending-cancels";
const MAX_ENTRIES = 400;
/** R2 drops an unfinished multipart upload after seven days: nothing older can be finished. */
const UNFINISHED_FOR_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

/** localStorage, or null where the browser refuses it. */
export function browserStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readRecord<TEntry>(storage: StorageLike | null, key: string): Record<string, TEntry> {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(key) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? (saved as Record<string, TEntry>) : {};
  } catch {
    return {};
  }
}

function writeRecord<TEntry>(storage: StorageLike | null, key: string, entries: Record<string, TEntry>): void {
  try {
    const keys = Object.keys(entries);
    for (const oldest of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete entries[oldest];
    if (keys.length === 0) storage?.removeItem(key);
    else storage?.setItem(key, JSON.stringify(entries));
  } catch {
    // Full or blocked: not remembered.
  }
}

type StartedEntry = { mediaId: string; at: number };

export type StartedFiles = {
  /** An upload this phone started (newest last). */
  record(size: number, fingerprint: string, mediaId: string, now?: number): void;
  /** The file's upload finished, failed for good or was cancelled: nothing left to finish. */
  finish(size: number, fingerprint: string): void;
  /** Forgets every record of this upload. */
  forgetMedia(mediaId: string): void;
  /** Whether this phone has an upload it started within the last seven days and hasn't finished. */
  hasUnfinished(now?: number): boolean;
};

export function createStartedFiles(storage: StorageLike | null): StartedFiles {
  const keyOf = (size: number, fingerprint: string) => `${size}:${fingerprint}`;
  return {
    record(size, fingerprint, mediaId, now = Date.now()) {
      const entries = readRecord<StartedEntry>(storage, STARTED_KEY);
      delete entries[keyOf(size, fingerprint)];
      entries[keyOf(size, fingerprint)] = { mediaId, at: now };
      writeRecord(storage, STARTED_KEY, entries);
    },
    finish(size, fingerprint) {
      const entries = readRecord<StartedEntry>(storage, STARTED_KEY);
      if (!(keyOf(size, fingerprint) in entries)) return;
      delete entries[keyOf(size, fingerprint)];
      writeRecord(storage, STARTED_KEY, entries);
    },
    forgetMedia(mediaId) {
      const entries = readRecord<StartedEntry>(storage, STARTED_KEY);
      const kept = Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry?.mediaId !== mediaId));
      if (Object.keys(kept).length !== Object.keys(entries).length) writeRecord(storage, STARTED_KEY, kept);
    },
    hasUnfinished(now = Date.now()) {
      return Object.values(readRecord<StartedEntry>(storage, STARTED_KEY)).some(
        (entry) => typeof entry?.at === "number" && now - entry.at < UNFINISHED_FOR_MILLISECONDS,
      );
    },
  };
}

export type PendingCancel = { mediaId: string; uploadId: string | null; at: number };

export type PendingCancels = {
  add(mediaId: string, uploadId: string | null, now?: number): void;
  remove(mediaId: string): void;
  list(): PendingCancel[];
};

/** The Cancels not yet answered, by upload. */
export function createPendingCancels(storage: StorageLike | null): PendingCancels {
  return {
    add(mediaId, uploadId, now = Date.now()) {
      const entries = readRecord<PendingCancel>(storage, PENDING_CANCELS_KEY);
      entries[mediaId] = { mediaId, uploadId, at: now };
      writeRecord(storage, PENDING_CANCELS_KEY, entries);
    },
    remove(mediaId) {
      const entries = readRecord<PendingCancel>(storage, PENDING_CANCELS_KEY);
      if (!(mediaId in entries)) return;
      delete entries[mediaId];
      writeRecord(storage, PENDING_CANCELS_KEY, entries);
    },
    list() {
      return Object.values(readRecord<PendingCancel>(storage, PENDING_CANCELS_KEY)).filter(
        (entry) => typeof entry?.mediaId === "string",
      );
    },
  };
}
