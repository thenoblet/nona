/*
 * What this phone remembers of its uploads between visits, in localStorage, small enough to ship
 * with the album page (which reads it before the uploader loads):
 * - the uploads it started and hasn't finished, and whether each was a photo or a video: back on
 *   the album, the page says what didn't finish sending and how to carry it on (Ruling BE), and
 *   once the couple close sharing, during the 24 hours an unfinished upload may still finish, it
 *   offers to finish them;
 * - the Cancels it couldn't get the server to answer, sent again on the next visit, so a guest's
 *   Cancel is never dropped.
 * Storage blocked or full only means nothing is remembered.
 */

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STARTED_KEY = "nona:started-files";
const PENDING_CANCELS_KEY = "nona:pending-cancels";
/** The notices on return the guest set aside ("Not now"), by upload. */
const NOTICE_DISMISSED_KEY = "nona:return-notice-dismissed";
/** The uploads an album tab is sending right now, by upload, with when it last said so. */
const SENDING_KEY = "nona:sending-now";
/** A tab that hasn't said it is still sending for this long has stopped (closed, or gone to sleep). */
const SENDING_FRESH_FOR_MILLISECONDS = 15_000;
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
  if (key === STARTED_KEY || key === NOTICE_DISMISSED_KEY) tellStartedListeners();
}

const startedListeners = new Set<() => void>();

function tellStartedListeners(): void {
  for (const listener of [...startedListeners]) listener();
}

/**
 * Hears each change to the uploads this phone started (one starting, finishing, cancelled), to the
 * notices set aside and to what this page is sending, here and in another tab of the album; returns
 * what stops it.
 */
export function subscribeToStartedFiles(listener: () => void): () => void {
  startedListeners.add(listener);
  const fromAnotherTab = (event: StorageEvent) => {
    if (event.key === STARTED_KEY || event.key === NOTICE_DISMISSED_KEY || event.key === SENDING_KEY || event.key === null) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", fromAnotherTab);
  return () => {
    startedListeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", fromAnotherTab);
  };
}

/** What a started upload was; null for one recorded before the page kept that. */
export type StartedKind = "photo" | "video";

type StartedEntry = { mediaId: string; at: number; kind?: StartedKind };

export type UnfinishedUpload = { mediaId: string; kind: StartedKind | null; at: number };

export type StartedFiles = {
  /** An upload this phone started (newest last), and whether it is a photo or a video. */
  record(size: number, fingerprint: string, mediaId: string, details?: { kind?: StartedKind; now?: number }): void;
  /** The file's upload finished, failed for good or was cancelled: nothing left to finish. */
  finish(size: number, fingerprint: string): void;
  /** Forgets every record of this upload. */
  forgetMedia(mediaId: string): void;
  /** The uploads this phone started within the last seven days and hasn't finished, oldest first. */
  unfinished(now?: number): UnfinishedUpload[];
  /** Whether there is any. */
  hasUnfinished(now?: number): boolean;
};

export function createStartedFiles(storage: StorageLike | null): StartedFiles {
  const keyOf = (size: number, fingerprint: string) => `${size}:${fingerprint}`;
  function unfinished(now = Date.now()): UnfinishedUpload[] {
    return Object.values(readRecord<StartedEntry>(storage, STARTED_KEY)).flatMap((entry) =>
      typeof entry?.at === "number" && typeof entry.mediaId === "string" && now - entry.at < UNFINISHED_FOR_MILLISECONDS
        ? [{ mediaId: entry.mediaId, kind: entry.kind === "photo" || entry.kind === "video" ? entry.kind : null, at: entry.at }]
        : [],
    );
  }
  return {
    record(size, fingerprint, mediaId, details = {}) {
      const entries = readRecord<StartedEntry>(storage, STARTED_KEY);
      delete entries[keyOf(size, fingerprint)];
      entries[keyOf(size, fingerprint)] = { mediaId, at: details.now ?? Date.now(), ...(details.kind ? { kind: details.kind } : {}) };
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
    unfinished,
    hasUnfinished(now = Date.now()) {
      return unfinished(now).length > 0;
    },
  };
}

/*
 * What is being sent right now, so the notice on return never says "didn't finish" of an upload
 * still on its way: from an uploader of this page left running behind a page React set aside, or
 * from another tab of the album. Each uploader says which uploads it has on their way (its
 * `owner` keys its share); the page writes them, with a heartbeat, for other tabs to read.
 */
const sendingHere = new Map<object, ReadonlySet<string>>();
let sendingHereVersion = 0;

function sendingHereNow(): Set<string> {
  return new Set([...sendingHere.values()].flatMap((mediaIds) => [...mediaIds]));
}

/** A beat: when a tab last said it sends this upload, and which tab. (An older beat is a bare time.) */
type SendingBeat = { at: number; tab: string } | number;

const beatAt = (beat: SendingBeat | undefined) => (typeof beat === "number" ? beat : typeof beat?.at === "number" ? beat.at : null);
const beatTab = (beat: SendingBeat | undefined) => (typeof beat === "object" && beat !== null && typeof beat.tab === "string" ? beat.tab : null);

const TAB_KEY = "nona:tab";
let thisTab: string | null = null;

/**
 * This tab's own name, kept in sessionStorage so the page reloaded in it keeps it: its beats are its
 * own (a reload's are of an uploader now gone), and only other tabs' beats hide the notice.
 */
export function currentTab(): string {
  if (thisTab) return thisTab;
  const fresh = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const session = typeof window === "undefined" ? null : window.sessionStorage;
    thisTab = session?.getItem(TAB_KEY) ?? null;
    if (!thisTab) {
      thisTab = fresh;
      session?.setItem(TAB_KEY, thisTab);
    }
  } catch {
    thisTab = fresh;
  }
  return thisTab;
}

/**
 * Writes this tab's beats into the stored record, keeping other tabs' (two tabs sending at once
 * mustn't erase each other's) and dropping any gone stale, and this tab's for uploads it no longer sends.
 */
function writeSending(storage: StorageLike | null, now: number, tab: string): void {
  const here = sendingHereNow();
  const entries = readRecord<SendingBeat>(storage, SENDING_KEY);
  for (const [mediaId, beat] of Object.entries(entries)) {
    const at = beatAt(beat);
    const stale = at === null || now - at >= SENDING_FRESH_FOR_MILLISECONDS;
    if (stale || (beatTab(beat) === tab && !here.has(mediaId))) delete entries[mediaId];
  }
  for (const mediaId of here) entries[mediaId] = { at: now, tab };
  writeRecord(storage, SENDING_KEY, entries);
}

/** An uploader's uploads on their way now (replacing what it said before); tells the page when that changes. */
export function setSendingHere(owner: object, mediaIds: Iterable<string>, storage: StorageLike | null, now = Date.now(), tab = currentTab()): void {
  const next = new Set(mediaIds);
  const before = sendingHere.get(owner) ?? new Set<string>();
  if (next.size === before.size && [...next].every((mediaId) => before.has(mediaId))) return;
  if (next.size === 0) sendingHere.delete(owner);
  else sendingHere.set(owner, next);
  sendingHereVersion += 1;
  writeSending(storage, now, tab);
  tellStartedListeners();
}

/** Says again, for other tabs, that this page's uploads are still on their way. */
export function stillSending(storage: StorageLike | null, now = Date.now(), tab = currentTab()): void {
  if (sendingHere.size > 0) writeSending(storage, now, tab);
}

/**
 * The page is going (a reload, a link, closing the tab): it stops saying it sends, so the page that
 * comes next (this one reloaded, or another tab) offers to carry the upload on at once, rather than
 * taking it for one still sending elsewhere. Kept in memory, should the page come back from the
 * back-forward cache: the next heartbeat says so again.
 */
export function stopSayingSending(storage: StorageLike | null, tab = currentTab()): void {
  const here = sendingHereNow();
  const entries = readRecord<SendingBeat>(storage, SENDING_KEY);
  const before = Object.keys(entries).length;
  for (const [mediaId, beat] of Object.entries(entries)) {
    if (here.has(mediaId) || beatTab(beat) === tab) delete entries[mediaId];
  }
  if (Object.keys(entries).length !== before) writeRecord(storage, SENDING_KEY, entries);
}

/** Another tab's fresh beats, by upload, with when each goes stale. */
function otherTabsSending(storage: StorageLike | null, now: number, tab: string): Map<string, number> {
  const fresh = new Map<string, number>();
  for (const [mediaId, beat] of Object.entries(readRecord<SendingBeat>(storage, SENDING_KEY))) {
    const at = beatAt(beat);
    if (at === null || beatTab(beat) === tab || now - at >= SENDING_FRESH_FOR_MILLISECONDS) continue;
    fresh.set(mediaId, at + SENDING_FRESH_FOR_MILLISECONDS);
  }
  return fresh;
}

/** When the soonest of another tab's beats goes stale (it may have been closed, or killed by the phone); null for none. */
export function nextSendingExpiry(storage: StorageLike | null, now = Date.now(), tab = currentTab()): number | null {
  const expiries = [...otherTabsSending(storage, now, tab).values()];
  return expiries.length > 0 ? Math.min(...expiries) : null;
}

/** Sets the notice on return aside ("Not now") for these uploads; another upload left unfinished brings it back. */
export function dismissReturnNotice(mediaIds: Iterable<string>, storage: StorageLike | null, now = Date.now()): void {
  const entries = readRecord<number>(storage, NOTICE_DISMISSED_KEY);
  for (const mediaId of mediaIds) entries[mediaId] = now;
  // A week on, R2 has let the upload go: nothing left to set aside.
  const kept = Object.fromEntries(Object.entries(entries).filter(([, at]) => typeof at === "number" && now - at < UNFINISHED_FOR_MILLISECONDS));
  writeRecord(storage, NOTICE_DISMISSED_KEY, kept);
}

/**
 * The uploads the notice on return speaks of: started here within the week and unfinished, not set
 * aside, and not on their way in this page or another tab.
 */
export function returnNoticeUploads(storage: StorageLike | null, now = Date.now(), tab = currentTab()): UnfinishedUpload[] {
  const dismissed = readRecord<number>(storage, NOTICE_DISMISSED_KEY);
  const sendingElsewhere = otherTabsSending(storage, now, tab);
  const here = sendingHereNow();
  return createStartedFiles(storage)
    .unfinished(now)
    .filter(({ mediaId }) => !here.has(mediaId) && typeof dismissed[mediaId] !== "number" && !sendingElsewhere.has(mediaId));
}

/**
 * Hears every change the notice on return rests on (as subscribeToStartedFiles), and also the moment
 * another tab's beat goes stale, so a tab the phone killed mid-upload hides the notice for fifteen
 * seconds, not the whole visit; returns what stops it.
 */
export function subscribeToReturnNotice(storage: StorageLike | null, listener: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchForExpiry = () => {
    clearTimeout(timer);
    const expiry = nextSendingExpiry(storage);
    if (expiry === null) return;
    timer = setTimeout(
      () => {
        listener();
        watchForExpiry();
      },
      Math.max(0, expiry - Date.now()) + 50,
    );
  };
  const unsubscribe = subscribeToStartedFiles(() => {
    listener();
    watchForExpiry();
  });
  watchForExpiry();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}

/**
 * Reads the notice on return through `describe`, again only when what it rests on has changed (the
 * stored records, as written, and what this page is sending) or another tab's beat has gone stale,
 * not on every render while files send.
 */
export function createReturnNoticeReader<TValue>(
  storage: StorageLike | null,
  describe: (uploads: UnfinishedUpload[]) => TValue,
  clock: () => number = Date.now,
  tab = currentTab(),
): () => TValue {
  let cached: { key: string; value: TValue; until: number } | null = null;
  const raw = (key: string) => {
    try {
      return storage?.getItem(key) ?? "";
    } catch {
      return "";
    }
  };
  return () => {
    const now = clock();
    const key = [raw(STARTED_KEY), raw(NOTICE_DISMISSED_KEY), raw(SENDING_KEY), sendingHereVersion].join("\n");
    if (cached?.key !== key || now >= cached.until) {
      const until = nextSendingExpiry(storage, now, tab) ?? Number.POSITIVE_INFINITY;
      cached = { key, value: describe(returnNoticeUploads(storage, now, tab)), until };
    }
    return cached.value;
  };
}

export type PendingCancel = { mediaId: string; uploadId: string | null; at: number };

export type PendingCancels = {
  add(mediaId: string, uploadId: string | null, now?: number): void;
  remove(mediaId: string): void;
  /** The Cancels still to send; one older than seven days is dropped, so none is sent for ever. */
  list(now?: number): PendingCancel[];
};

/** How long a Cancel is kept: as long as R2 keeps an unfinished upload. */
const PENDING_CANCEL_FOR_MILLISECONDS = UNFINISHED_FOR_MILLISECONDS;

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
    list(now = Date.now()) {
      const entries = readRecord<PendingCancel>(storage, PENDING_CANCELS_KEY);
      const current = (entry: PendingCancel | undefined) =>
        typeof entry?.mediaId === "string" && typeof entry.at === "number" && now - entry.at < PENDING_CANCEL_FOR_MILLISECONDS;
      const kept = Object.fromEntries(Object.entries(entries).filter(([, entry]) => current(entry)));
      if (Object.keys(kept).length !== Object.keys(entries).length) writeRecord(storage, PENDING_CANCELS_KEY, kept);
      return Object.values(kept);
    },
  };
}
