import { checkUpload } from "@/lib/media/limits";

/*
 * What the album page shows of the guest's uploads, framework-free and small: it ships with the
 * page, so a pick shows at once (and a file over its limit is turned away at once) while the
 * uploader itself (engine.ts, with Uppy) loads. The engine moves each file through its states;
 * the cards render the snapshot.
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
 */
export type UploadStatus = "queued" | "sending" | "retrying" | "confirming" | "added" | "failed";

export type UploadFailure = { reason: string; hint: string | null; canRetry: boolean };

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
};

export type UploadView =
  | { kind: "none" }
  /** One shot from the camera: the camera card. */
  | { kind: "camera"; item: UploadItem }
  /** Anything else: the gallery batch, "N of M sent", with an overall bar by bytes. */
  | { kind: "batch"; items: readonly UploadItem[]; sent: number; total: number; busy: boolean; percent: number };

export type UploadSnapshot = {
  readonly items: readonly UploadItem[];
  readonly view: UploadView;
  /** Whether a file has been added on this page yet: the personal link is offered from then on. */
  readonly showLinkOffer: boolean;
};

export type ItemPatch = Partial<Pick<UploadItem, "status" | "percent" | "mediaId" | "failure">>;

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
} as const;

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

function viewOf(items: readonly UploadItem[]): UploadView {
  if (items.length === 0) return { kind: "none" };
  if (items.length === 1 && items[0].source !== "gallery") return { kind: "camera", item: items[0] };
  const totalBytes = items.reduce((total, item) => total + item.file.size, 0);
  const sentBytes = items.reduce((total, item) => total + (item.file.size * item.percent) / 100, 0);
  return {
    kind: "batch",
    items,
    sent: items.filter((item) => item.status === "added").length,
    total: items.length,
    busy: items.some(isBusy),
    percent: totalBytes === 0 ? 0 : Math.round((sentBytes / totalBytes) * 100),
  };
}

export type PreviewUrls = { create: (file: File) => string | null; revoke: (url: string) => void };

const browserPreviews: PreviewUrls = {
  create: (file) => (typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : null),
  revoke: (url) => URL.revokeObjectURL(url),
};

export type UploadStore = {
  /**
   * Adds the picked files, each queued, or failed at once when the album can't take it, and returns
   * the queued ones. A pick while nothing is sending starts afresh: the added files and the ones
   * that can't be tried again leave the card; the ones to try again stay.
   */
  add(files: readonly File[], source: UploadSource): UploadItem[];
  update(id: string, patch: ItemPatch): void;
  remove(id: string): void;
  get(id: string): UploadItem | undefined;
  getSnapshot(): UploadSnapshot;
  subscribe(listener: () => void): () => void;
};

export function createUploadStore(options: { previews?: PreviewUrls; newId?: () => string } = {}): UploadStore {
  const previews = options.previews ?? browserPreviews;
  let made = 0;
  const newId = options.newId ?? (() => `upload-${Date.now().toString(36)}-${(made += 1)}`);
  const listeners = new Set<() => void>();
  let items: readonly UploadItem[] = [];
  let showLinkOffer = false;
  let snapshot: UploadSnapshot = { items, view: viewOf(items), showLinkOffer };

  function commit(next: readonly UploadItem[]): void {
    items = next;
    showLinkOffer ||= items.some((item) => item.status === "added");
    snapshot = { items, view: viewOf(items), showLinkOffer };
    for (const listener of listeners) listener();
  }

  function forget(item: UploadItem): void {
    if (item.previewUrl) previews.revoke(item.previewUrl);
  }

  return {
    add(files, source) {
      let kept = items;
      if (!items.some(isBusy)) {
        const leaving = items.filter((item) => item.status === "added" || !item.failure?.canRetry);
        leaving.forEach(forget);
        kept = items.filter((item) => !leaving.includes(item));
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
        };
      });
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
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
