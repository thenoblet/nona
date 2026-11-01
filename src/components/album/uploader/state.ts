import { checkUpload } from "@/lib/media/limits";

/*
 * What the album page shows of the guest's uploads, framework-free and small: it ships with the
 * page, so a pick shows at once (and a file over its limit is turned away at once) while the
 * uploader itself (engine.ts, with Uppy) loads. The engine moves each file through its states;
 * the cards render the snapshot. Once a card has finished, it tidies itself away (Ruling BC); while
 * files send, it can be minimised to a floating circle, and a big or slow upload says so calmly
 * (Ruling BE).
 */

/** Where a file comes from: the phone's camera (a photo or a video) or its gallery. */
export type UploadSource = "photo" | "video" | "gallery";

/**
 * A file's state, as gate A shows it:
 * - queued: "Waiting to send"
 * - sending: "Sending" and its percentage (its fingerprint and start included)
 * - retrying: "Retrying, keep this page open" (a part, or the whole file, trying again by itself)
 * - confirming: every byte sent, waiting for the server's answer ("Checking it arrived safely")
 * - added: the server has verified it ("Added to the album"); nothing else ever shows this
 * - failed: a plain reason, with Try again only where trying again can help
 * - cancelling: the guest tapped Cancel and the server hasn't answered yet; not shown, and should
 *   the server never answer, failed with "We couldn't remove this one yet" and Try again
 */
export type UploadStatus = "queued" | "sending" | "retrying" | "confirming" | "added" | "failed" | "cancelling";

export type UploadFailure = {
  /** The plain words: a card's title, a row's label. */
  reason: string;
  hint: string | null;
  canRetry: boolean;
  /** Sharing closed: nothing to try again or take another of. */
  closed?: boolean;
  /** The guest's Cancel never got an answer: Try again sends the Cancel again. */
  cancelFailed?: boolean;
  /**
   * The file changed on the phone after it was picked (Ruling BA), so the browser can't read it any
   * more: only picking it again can help, and its button opens the picker.
   */
  chooseAgain?: boolean;
};

export type UploadItem = {
  readonly id: string;
  readonly file: File;
  readonly source: UploadSource;
  /** The type the upload declares: the file's own, or one from its name when the phone gave none. */
  readonly contentType: string;
  readonly kind: "photo" | "video";
  /** An object URL of the guest's own file for its thumbnail; null where none can be made. */
  readonly previewUrl: string | null;
  readonly status: UploadStatus;
  readonly percent: number;
  readonly mediaId: string | null;
  readonly failure: UploadFailure | null;
  /** Fading away once the card has finished with it (Ruling BC). */
  readonly leaving: boolean;
  /**
   * The server's own thumbnail, for a file the phone can't preview (a HEIC on Android). Null until
   * Task 15's GET /api/media/[id] gives it once the item is ready: the seam for swapping it in.
   */
  readonly serverThumbUrl: string | null;
};

export type UploadView =
  | { kind: "none" }
  /** One shot from the camera: the camera card. */
  | { kind: "camera"; item: UploadItem }
  /**
   * Anything else: the gallery batch, "N of M sent", with an overall bar by bytes. N and M still
   * count the added files that have tidied away from it while others wait for Try again.
   */
  | { kind: "batch"; items: readonly UploadItem[]; sent: number; total: number; busy: boolean; percent: number };

export type UploadSnapshot = {
  readonly items: readonly UploadItem[];
  readonly view: UploadView;
  /** Whether a file has been added on this page yet: the personal link is offered from then on. */
  readonly showLinkOffer: boolean;
  /** The card is minimised to the floating progress circle (Ruling BE). */
  readonly minimised: boolean;
  /** For a big or slow upload, the calm words that say so (Ruling BE); null otherwise. */
  readonly notice: string | null;
  /** With that notice, the time left in words, once it has been measured. */
  readonly timeLeft: string | null;
};

export type ItemPatch = Partial<Pick<UploadItem, "status" | "percent" | "mediaId" | "failure" | "serverThumbUrl">>;

/** Gate A's words, and the few the design needed beyond them. */
export const UPLOAD_WORDS = {
  waiting: "Waiting to send",
  sending: "Sending",
  retrying: "Retrying, keep this page open",
  added: "Added",
  unreadable: "We couldn't read this file",
  overVideoLimit: "This file is over 2 GB",
  overPhotoLimit: "This file is over 50 MB",
  trimHint: "Trim it in your gallery, then choose it again.",
  /** The worker's `too-large`: more pixels than the album takes. */
  tooLargeToShow: "This file is too large for the album",
  /** A file the server lost track of (its row or its upload gone): sending it again starts afresh. */
  notSent: "We couldn't send this file",
  /** A connection that kept dropping for minutes: the file waits for the guest's Try again. */
  connectionDropped: "The connection dropped",
  /** A file the phone took over a minute to open (one kept in the cloud, still downloading). */
  slowToOpen: "This file took too long to open",
  /** The couple closed sharing: the card's short title, the server's words beneath it. */
  sharingClosed: "Sharing has closed",
  /** An upload R2 or the server let go of before it finished: Try again starts it afresh. */
  expired: "This upload expired before it arrived",
  /** A file the couple hid (or deleted): picking it again never brings it back. */
  cantAdd: "This one can't be added to the album",
  /** A Cancel the server never answered, kept and sent again on the next visit. */
  cancelUnanswered: "We couldn't remove this one yet",
  /** Ruling BA: a file the phone can no longer read, as it changed after the pick; the button opens the picker. */
  photoChanged: "This photo changed after you chose it",
  videoChanged: "This video changed after you chose it",
  chooseItAgain: "Choose it again.",
  /** Ruling BE: a big or slow upload, said calmly; a page can't send once it closes, so never promise that. */
  bigVideo: "This is a big video, so it may take a few minutes on mobile data.",
  bigVideoAmong: "There's a big video in these, so they may take a few minutes on mobile data.",
  slowOne: "This may take a few minutes on mobile data.",
  slowSeveral: "These may take a few minutes on mobile data.",
  keepLooking: "You can minimise this and keep looking through the album; just keep this page open.",
} as const;

/** Gate A's captions under the camera card's title, by state. */
const CAMERA_CAPTIONS: Partial<Record<UploadStatus, string>> = {
  queued: "Keep this page open for a moment",
  sending: "Keep this page open for a moment",
  retrying: UPLOAD_WORDS.retrying,
  confirming: "Checking it arrived safely",
  added: "Everyone will see it shortly",
};

/**
 * The camera card's caption: a failure's hint; gate A's words for retrying, checking and added; and
 * while a big or slow upload waits or sends, its time left (once measured) in place of "for a
 * moment", which its notice would contradict.
 */
export function cameraCaption(item: Pick<UploadItem, "status" | "failure">, notice: string | null, timeLeft: string | null): string | null {
  if (item.failure) return item.failure.hint;
  if (notice && (item.status === "queued" || item.status === "sending")) {
    return timeLeft ? `${timeLeft.charAt(0).toUpperCase()}${timeLeft.slice(1)}` : null;
  }
  return CAMERA_CAPTIONS[item.status] ?? null;
}

/** A file over this (about 100 MB) is big: the card says it may take a few minutes, whatever the time left. */
export const BIG_FILE_BYTES = 100 * 1024 * 1024;
/** Past this many seconds left, measured, the card says so too. */
export const SLOW_SECONDS = 60;

const BUSY: ReadonlySet<UploadStatus> = new Set(["queued", "sending", "retrying", "confirming"]);

export function isBusy(item: Pick<UploadItem, "status">): boolean {
  return BUSY.has(item.status);
}

// What a phone that gives no type means by a file's name: the album's own types only.
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
  hif: "image/heic",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  qt: "video/quicktime",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mkv: "video/x-matroska",
};

// Older names some phones still give the album's types.
const TYPE_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "video/x-m4v": "video/mp4",
  "video/3gp": "video/3gpp",
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The type to declare for a file: its own (by its usual name), or, when the phone gave none, the
 * one its name says. application/octet-stream is left for the API, which takes it only for HEIC.
 */
export function declaredType(file: Pick<File, "name" | "type">): string {
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (type) return TYPE_ALIASES[type] ?? type;
  return TYPE_BY_EXTENSION[extensionOf(file.name)] ?? "application/octet-stream";
}

/**
 * Whether the album takes the file, checked before any byte is sent (the upload API checks again):
 * null when it does, else why not. Over its limit, in gate A's words, with no Try again.
 */
function refusal(file: File, contentType: string, kind: UploadItem["kind"]): UploadFailure | null {
  const checked = checkUpload({ purpose: "album", filename: file.name, contentType, size: file.size });
  if (checked.ok) return null;
  if (checked.error === "too-large") {
    return kind === "video"
      ? { reason: UPLOAD_WORDS.overVideoLimit, hint: UPLOAD_WORDS.trimHint, canRetry: false }
      : { reason: UPLOAD_WORDS.overPhotoLimit, hint: null, canRetry: false };
  }
  return { reason: checked.message, hint: null, canRetry: false };
}

/** Added files of the card that have tidied away: still counted in its "N of M sent" and its bar. */
type Tidied = { files: number; bytes: number };

function viewOf(allItems: readonly UploadItem[], tidied: Tidied): UploadView {
  // A file being cancelled has left the card already.
  const items = allItems.filter((item) => item.status !== "cancelling");
  if (items.length === 0) return { kind: "none" };
  if (items.length === 1 && items[0].source !== "gallery" && tidied.files === 0) return { kind: "camera", item: items[0] };
  // The overall bar counts only what is still to arrive: a failed file (over its limit, or waiting
  // for Try again) would hold it short of the end for ever. "N of M sent" still counts every file.
  // Files that arrived and tidied away still count as sent, so the bar never drops back.
  const sending = items.filter((item) => item.status !== "failed");
  const totalBytes = sending.reduce((total, item) => total + item.file.size, tidied.bytes);
  const sentBytes = sending.reduce((total, item) => total + (item.file.size * item.percent) / 100, tidied.bytes);
  return {
    kind: "batch",
    items,
    sent: items.filter((item) => item.status === "added").length + tidied.files,
    total: items.length + tidied.files,
    busy: items.some(isBusy),
    percent: totalBytes === 0 ? 0 : Math.round((sentBytes / totalBytes) * 100),
  };
}

/**
 * The calm notice for a big or slow upload (Ruling BE): a file over about 100 MB is sending, or the
 * measured time left has passed about a minute (`slow`, kept until the files have sent).
 */
function noticeOf(items: readonly UploadItem[], slow: boolean): string | null {
  const busy = items.filter((item) => item.status !== "cancelling" && isBusy(item));
  if (busy.length === 0) return null;
  const big = busy.some((item) => item.file.size > BIG_FILE_BYTES);
  if (!big && !slow) return null;
  const one = busy.length === 1;
  const lead = big ? (one ? UPLOAD_WORDS.bigVideo : UPLOAD_WORDS.bigVideoAmong) : one ? UPLOAD_WORDS.slowOne : UPLOAD_WORDS.slowSeveral;
  return `${lead} ${UPLOAD_WORDS.keepLooking}`;
}

/** What a file's thumbnail shows (Ruling BB). */
export type ThumbSource = { kind: "local" | "server"; url: string } | { kind: "icon"; icon: "image" | "video" };

/**
 * The guest's own picture while the phone can draw it; else the server's thumbnail once there is
 * one (Task 15); else a small photo or video icon, never an empty tile.
 */
export function thumbOf(item: Pick<UploadItem, "kind" | "previewUrl" | "serverThumbUrl">, localFailed: boolean): ThumbSource {
  if (item.previewUrl && !localFailed) return { kind: "local", url: item.previewUrl };
  if (item.serverThumbUrl) return { kind: "server", url: item.serverThumbUrl };
  return { kind: "icon", icon: item.kind === "video" ? "video" : "image" };
}

/**
 * The notice on return (Ruling BE), for the uploads this phone started and didn't finish: what
 * didn't finish sending, and that choosing it again carries it on. Null for none.
 */
export function returnNoticeWords(unfinished: readonly { kind: "photo" | "video" | null }[]): string | null {
  if (unfinished.length === 0) return null;
  if (unfinished.length === 1) {
    const [{ kind }] = unfinished;
    const what = kind === "video" ? "Your video" : kind === "photo" ? "Your photo" : "One of your files";
    return `${what} didn't finish sending. Choose it again and it'll carry on from where it stopped.`;
  }
  const noun = unfinished.every(({ kind }) => kind === "video") ? "videos" : unfinished.every(({ kind }) => kind === "photo") ? "photos" : "files";
  return `${unfinished.length} of your ${noun} didn't finish sending. Choose them again and they'll carry on from where they stopped.`;
}

export type PreviewUrls = { create: (file: File) => string | null; revoke: (url: string) => void };

const browserPreviews: PreviewUrls = {
  create: (file) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null),
  revoke: (url) => URL.revokeObjectURL(url),
};

/** How long a finished card shows before it tidies itself away, and how long it takes to fade (Ruling BC). */
export type TidyTimings = { batchMs: number; cameraMs: number; fadeMs: number };

// The fade is the cards' fold (420 ms in globals.css), with a moment to spare.
export const TIDY_TIMINGS: TidyTimings = { batchMs: 5_000, cameraMs: 15_000, fadeMs: 450 };

/** The guest asked for less motion: a finished card goes without its fade. */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export type UploadStore = {
  /**
   * Adds the picked files, each queued, or failed at once when the album can't take it, and returns
   * the queued ones. A pick while nothing is sending starts afresh: the added files and the ones
   * that can't be tried again leave the card; the ones to try again stay. `replacing` names a file
   * that changed after it was picked (Ruling BA), whose place these take.
   */
  add(files: readonly File[], source: UploadSource, options?: { replacing?: string }): UploadItem[];
  update(id: string, patch: ItemPatch): void;
  remove(id: string): void;
  get(id: string): UploadItem | undefined;
  /** Minimises the card to the floating circle, or opens it again (Ruling BE). */
  setMinimised(minimised: boolean): void;
  /** The measured time left (from the uploader), for a slow upload's notice. */
  setTimeLeft(timeLeft: { seconds: number; words: string } | null): void;
  getSnapshot(): UploadSnapshot;
  subscribe(listener: () => void): () => void;
};

export function createUploadStore(
  options: {
    previews?: PreviewUrls;
    newId?: () => string;
    tidy?: Partial<TidyTimings>;
    reducedMotion?: () => boolean;
  } = {},
): UploadStore {
  const previews = options.previews ?? browserPreviews;
  const tidyTimings = { ...TIDY_TIMINGS, ...options.tidy };
  const reducedMotion = options.reducedMotion ?? prefersReducedMotion;
  let made = 0;
  const newId = options.newId ?? (() => `upload-${Date.now().toString(36)}-${(made += 1)}`);
  const listeners = new Set<() => void>();
  let items: readonly UploadItem[] = [];
  let showLinkOffer = false;
  /** Added files of this batch that have tidied away, still counted in its "N of M sent" and its bar. */
  let tidied: Tidied = { files: 0, bytes: 0 };
  let minimised = false;
  let timeLeft: { seconds: number; words: string } | null = null;
  /** The measured time left has passed SLOW_SECONDS while these files send. */
  let slow = false;
  let tidyTimer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: UploadSnapshot = snapshotOf();

  function snapshotOf(): UploadSnapshot {
    const notice = noticeOf(items, slow);
    return {
      items,
      view: viewOf(items, tidied),
      showLinkOffer,
      minimised,
      notice,
      timeLeft: notice && timeLeft ? timeLeft.words : null,
    };
  }

  function commit(next: readonly UploadItem[]): void {
    items = next;
    showLinkOffer ||= items.some((item) => item.status === "added");
    const onCard = items.filter((item) => item.status !== "cancelling");
    if (onCard.length === 0) {
      // The card has gone: the next one starts its own count, open.
      tidied = { files: 0, bytes: 0 };
      minimised = false;
    }
    if (!onCard.some(isBusy)) {
      slow = false;
      timeLeft = null;
    }
    snapshot = snapshotOf();
    planTidy();
    for (const listener of listeners) listener();
  }

  /**
   * Once nothing on the card is on its way and something has been added, the added files tidy
   * away after a while: a batch's after about 5 s, the camera card's after about 15 s. Failed files
   * stay until dismissed or tried again; trying again stops the clock.
   */
  function planTidy(): void {
    const onCard = items.filter((item) => item.status !== "cancelling");
    const waiting = onCard.some((item) => item.status === "added" && !item.leaving);
    if (onCard.some(isBusy) || !waiting) {
      clearTimeout(tidyTimer);
      tidyTimer = undefined;
      return;
    }
    if (tidyTimer !== undefined) return;
    const camera = snapshot.view.kind === "camera";
    tidyTimer = setTimeout(tidyAway, camera ? tidyTimings.cameraMs : tidyTimings.batchMs);
  }

  function tidyAway(): void {
    tidyTimer = undefined;
    const going = items.filter((item) => item.status === "added" && !item.leaving).map((item) => item.id);
    if (going.length === 0) return;
    if (reducedMotion()) {
      removeTidied(going);
      return;
    }
    commit(items.map((item) => (going.includes(item.id) ? { ...item, leaving: true } : item)));
    setTimeout(() => removeTidied(going), tidyTimings.fadeMs);
  }

  function removeTidied(ids: readonly string[]): void {
    const going = items.filter((item) => ids.includes(item.id) && item.status === "added");
    if (going.length === 0) return;
    going.forEach(forget);
    tidied = {
      files: tidied.files + going.length,
      bytes: tidied.bytes + going.reduce((total, item) => total + item.file.size, 0),
    };
    commit(items.filter((item) => !going.includes(item)));
  }

  function forget(item: UploadItem): void {
    if (item.previewUrl) previews.revoke(item.previewUrl);
  }

  return {
    add(files, source, addOptions = {}) {
      let kept = items;
      const replaced = addOptions.replacing ? items.find((item) => item.id === addOptions.replacing) : undefined;
      if (replaced) {
        forget(replaced);
        kept = kept.filter((item) => item !== replaced);
      }
      if (!kept.some(isBusy)) {
        const leaving = kept.filter(
          (item) => item.status !== "cancelling" && (item.status === "added" || !item.failure?.canRetry),
        );
        leaving.forEach(forget);
        kept = kept.filter((item) => !leaving.includes(item));
        tidied = { files: 0, bytes: 0 };
      }
      const added = files.map((file): UploadItem => {
        const contentType = declaredType(file);
        const kind = contentType.startsWith("video/") ? "video" : "photo";
        const failure = refusal(file, contentType, kind);
        return {
          id: newId(),
          file,
          source,
          contentType,
          kind,
          previewUrl: previews.create(file),
          status: failure ? "failed" : "queued",
          percent: 0,
          mediaId: null,
          failure,
          leaving: false,
          serverThumbUrl: null,
        };
      });
      // A new pick is something the guest wants to see: the card opens again.
      minimised = false;
      commit([...kept, ...added]);
      return added.filter((item) => item.status === "queued");
    },
    update(id, patch) {
      if (!items.some((item) => item.id === id)) return;
      commit(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    },
    remove(id) {
      const leaving = items.find((item) => item.id === id);
      if (!leaving) return;
      forget(leaving);
      commit(items.filter((item) => item.id !== id));
    },
    get: (id) => items.find((item) => item.id === id),
    setMinimised(value) {
      const next = value && snapshot.view.kind !== "none";
      if (next === minimised) return;
      minimised = next;
      commit(items);
    },
    setTimeLeft(value) {
      timeLeft = value;
      if (value && value.seconds > SLOW_SECONDS) slow = true;
      commit(items);
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
