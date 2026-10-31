import AwsS3, { type AwsS3Part, type AwsS3UploadParameters } from "@uppy/aws-s3";
import Uppy, { type UppyFile } from "@uppy/core";
import { PART_SIZE_BYTES } from "@/lib/media/limits";
import { createApiClient, type ApiClient } from "./api";
import { EventReporter } from "./events";
import {
  completionOutcome,
  errorOutcome,
  OutcomeError,
  partsOutcome,
  probeOutcome,
  startOutcome,
  type Outcome,
  type UploadSession,
} from "./outcomes";
import { PartUrlCache, type PartUrl } from "./presign-cache";
import { createSentFiles, fingerprintFile, type SentFiles } from "./resume";
import { UPLOAD_WORDS, type UploadStore } from "./state";

/*
 * The uploader: every file a presigned multipart upload straight to R2 in 8 MiB parts, through
 * Uppy 5's @uppy/aws-s3, with the site's own API for each step. Loaded apart from the album page
 * (load.ts). Uppy 5's traps, and how each is met:
 * - It would create the multipart upload itself. Instead the uploader awaits POST /api/guest once,
 *   fingerprints the file and calls POST /api/uploads first (which resumes this guest's unfinished
 *   upload of the same file, renamed or not), then sets the file's s3Multipart state, so Uppy
 *   takes its "restoring" path: it lists the parts R2 already holds (the start's own list, the
 *   first time) and sends only the rest. createMultipartUpload only returns that state.
 * - It aborts the multipart upload on any final error, which would lose every part sent. Its
 *   abortMultipartUpload does nothing: only the guest's Cancel ends an upload, through DELETE
 *   /api/uploads/[id] (and "Remove my upload" when that answers already-uploaded).
 * - Its upload() retries every failed file it still holds, its own way. A file leaves Uppy as soon
 *   as it succeeds or fails; Try again runs it through this same path.
 * - It signs each part with its own call. signPart reads presign-cache.ts, 20 parts a call.
 * - It never times a PUT out. Each part's PUT is dropped and retried after a minute without progress.
 * Files go three at a time and parts four at a time (Uppy's limit, across files). A part that
 * fails is retried by Uppy with backoff; a file whose trouble outlasts that (no signal for a while)
 * tries again by itself for about five minutes, then waits for the guest's Try again. A file shows
 * "Added" only once its complete answers that the server verified it.
 */

const FILES_IN_FLIGHT = 3;
const PARTS_IN_FLIGHT = 4;
/** Uppy's waits before each retry of a part's PUT, or of signing it. */
const PART_RETRY_DELAYS_MILLISECONDS = [0, 1_000, 3_000, 5_000, 10_000];
/** The file's own waits before it starts again by itself, about five minutes in all. */
const FILE_RETRY_DELAYS_MILLISECONDS = [3_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000, 60_000];
/** A part's PUT with no progress for this long is dropped and sent again. */
const PART_STALL_MILLISECONDS = 60_000;
/** Each call's timeout. A complete may take the server up to 40 s (its R2 budget). */
const TIMEOUTS = { guest: 10_000, start: 20_000, parts: 15_000, complete: 60_000, cancel: 20_000 };
/** Cancelling (or removing) on the server: tried this many times, a little apart, then left. */
const CANCEL_RETRY_DELAYS_MILLISECONDS = [2_000, 5_000, 10_000, 20_000];

type FileMeta = { itemId: string; relativePath: string };
type FileBody = Record<string, never>;
type EngineFile = UppyFile<FileMeta, FileBody>;

/** What the uploader keeps of a file it has started, beyond what the store shows. */
type Run = {
  itemId: string;
  file: File;
  fingerprint: string | null;
  session: UploadSession | null;
  partUrls: PartUrlCache | null;
  /** The parts the start listed, for Uppy's first listParts; later ones ask the server. */
  startParts: UploadSession["uploadedParts"] | null;
  uppyFileId: string | null;
  /** Settles the current attempt: Uppy's success or error, or the uploader giving up on it. */
  settle: { resolve: () => void; reject: (error: unknown) => void } | null;
  /** Ends this attempt's own API calls when the guest cancels. */
  abort: AbortController;
  partAttempts: Map<number, number>;
  autoRetries: number;
  retryAt: number;
  bytesSent: number;
  cancelled: boolean;
};

export type EngineOptions = {
  /** The guest's name on this phone, sent with their guest and each upload. */
  guestName: () => string | null;
  /** Called with the guest's personal link once POST /api/guest answers. */
  onPersonalLink: (link: string) => void;
};

export type Engine = {
  /** Starts the queued files, up to three at a time. */
  pump(): void;
  /** Try again: sends a failed file again through the same path. */
  retry(itemId: string): void;
  /** Cancel: stops the file and ends its upload on the server (removing it if it already arrived). */
  cancel(itemId: string): void;
};

function storageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

function toS3Part(part: { partNumber: number; etag: string; size: number }): AwsS3Part {
  return { PartNumber: part.partNumber, ETag: part.etag, Size: part.size };
}

class UploadEngine implements Engine {
  readonly #store: UploadStore;
  readonly #options: EngineOptions;
  readonly #api: ApiClient;
  readonly #events: EventReporter;
  readonly #sentFiles: SentFiles;
  readonly #uppy: Uppy<FileMeta, FileBody>;
  readonly #runs = new Map<string, Run>();
  readonly #active = new Set<string>();
  /** Which file and part each handed-out part URL is for, so a failed PUT can say. */
  readonly #partOfUrl = new Map<string, { itemId: string; partNumber: number; attempt: number }>();
  #guest: Promise<void> | null = null;
  #pumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: UploadStore, options: EngineOptions) {
    this.#store = store;
    this.#options = options;
    this.#api = createApiClient();
    this.#events = new EventReporter(this.#api);
    this.#sentFiles = createSentFiles(storageOrNull());
    this.#uppy = new Uppy<FileMeta, FileBody>({ id: "nona-album", autoProceed: false, allowMultipleUploadBatches: true });
    this.#uppy.use(AwsS3<FileMeta, FileBody>, {
      shouldUseMultipart: true,
      limit: PARTS_IN_FLIGHT,
      retryDelays: PART_RETRY_DELAYS_MILLISECONDS,
      getChunkSize: () => PART_SIZE_BYTES,
      createMultipartUpload: (file) => {
        const session = this.#runOfFile(file).session;
        if (!session) throw new Error("The upload hasn't started");
        return { uploadId: session.uploadId, key: session.key };
      },
      listParts: (file, { signal }) => this.#listParts(file, signal),
      signPart: (file, { partNumber, signal }) => this.#signPart(file, partNumber, signal),
      abortMultipartUpload: async () => {},
      completeMultipartUpload: (file, { parts, signal }) => this.#complete(file, parts, signal),
      uploadPartBytes: (options) => this.#putPart(options),
    });
    this.#uppy.on("upload-progress", (file, progress) => {
      const run = file && this.#runs.get(file.meta.itemId);
      if (!run || run.cancelled || !progress.bytesTotal) return;
      const sent = Number(progress.bytesUploaded) || 0;
      const item = this.#store.get(run.itemId);
      if (!item || (item.status !== "sending" && item.status !== "retrying")) return;
      const moved = sent > run.bytesSent;
      run.bytesSent = Math.max(run.bytesSent, sent);
      const percent = Math.max(item.percent, Math.floor((run.bytesSent / progress.bytesTotal) * 100));
      this.#store.update(run.itemId, { percent, status: moved ? "sending" : item.status });
    });
    this.#uppy.on("upload-success", (file) => this.#settled(file, null));
    this.#uppy.on("upload-error", (file, error) => this.#settled(file, error ?? new Error("The upload failed")));
    window.addEventListener("online", () => this.pump());
  }

  // ---------- The queue ----------

  pump(): void {
    clearTimeout(this.#pumpTimer);
    if (isOffline()) return;
    const now = Date.now();
    let wakeAt = Number.POSITIVE_INFINITY;
    for (const item of this.#store.getSnapshot().items) {
      if (this.#active.size >= FILES_IN_FLIGHT) break;
      if (this.#active.has(item.id) || (item.status !== "queued" && item.status !== "retrying")) continue;
      const run = this.#runs.get(item.id);
      if (run && run.retryAt > now) {
        wakeAt = Math.min(wakeAt, run.retryAt);
        continue;
      }
      this.#active.add(item.id);
      void this.#run(item.id);
    }
    if (wakeAt < Number.POSITIVE_INFINITY) this.#pumpTimer = setTimeout(() => this.pump(), wakeAt - now);
  }

  retry(itemId: string): void {
    const item = this.#store.get(itemId);
    if (!item || item.status !== "failed" || !item.failure?.canRetry) return;
    const run = this.#runs.get(itemId);
    if (run) {
      run.autoRetries = 0;
      run.retryAt = 0;
      // A file the phone couldn't read is read afresh.
      if (item.failure.reason === UPLOAD_WORDS.unreadable) run.fingerprint = null;
    }
    this.#store.update(itemId, { status: "queued", failure: null });
    this.pump();
  }

  cancel(itemId: string): void {
    const item = this.#store.get(itemId);
    if (!item || item.status === "added") return;
    const run = this.#runs.get(itemId);
    this.#store.remove(itemId);
    if (!run) return;
    run.cancelled = true;
    run.abort.abort();
    this.#leaveUppy(run);
    run.settle?.reject(new DOMException("The guest cancelled", "AbortError"));
    const mediaId = run.session?.mediaId ?? item.mediaId;
    if (mediaId) void this.#cancelOnServer(run, mediaId);
  }

  // ---------- One file ----------

  #runOf(itemId: string, file: File): Run {
    let run = this.#runs.get(itemId);
    if (!run) {
      run = {
        itemId,
        file,
        fingerprint: null,
        session: null,
        partUrls: null,
        startParts: null,
        uppyFileId: null,
        settle: null,
        abort: new AbortController(),
        partAttempts: new Map(),
        autoRetries: 0,
        retryAt: 0,
        bytesSent: 0,
        cancelled: false,
      };
      this.#runs.set(itemId, run);
    }
    return run;
  }

  #runOfFile(file: EngineFile | undefined): Run {
    const run = file && this.#runs.get(file.meta.itemId);
    if (!run) throw new Error("Uppy asked about a file the uploader doesn't have");
    return run;
  }

  async #run(itemId: string): Promise<void> {
    const item = this.#store.get(itemId);
    if (!item) {
      this.#active.delete(itemId);
      return;
    }
    const run = this.#runOf(itemId, item.file);
    run.abort = new AbortController();
    run.retryAt = 0;
    this.#store.update(itemId, { status: "sending", failure: null });
    try {
      await this.#ensureGuest();
      if (run.cancelled) return;
      run.fingerprint ??= await fingerprintFile(run.file);
      if (run.cancelled) return;
      if (this.#isDuplicate(run)) {
        // The same file picked twice while the first is still sending: the first one carries it.
        this.#store.remove(itemId);
        this.#runs.delete(itemId);
        return;
      }
      if (await this.#settledBefore(run)) return;
      await this.#start(run);
      if (run.cancelled) return;
      await this.#send(run);
      if (run.cancelled) return;
      this.#added(run);
    } catch (error) {
      if (run.cancelled) return;
      const outcome = errorOutcome(error);
      if (outcome.kind === "cancelled") return;
      if (outcome.kind === "added") this.#added(run);
      else if (outcome.kind === "failed") this.#failed(run, outcome);
      else this.#retryLater(run, outcome);
    } finally {
      this.#active.delete(itemId);
      this.pump();
    }
  }

  /** Awaits POST /api/guest once for the page, before any start, so a first batch makes one guest. */
  #ensureGuest(): Promise<void> {
    this.#guest ??= this.#api
      .request("/api/guest", { method: "POST", body: { displayName: this.#options.guestName() ?? undefined }, timeoutMs: TIMEOUTS.guest })
      .then((answer) => {
        if (answer.status !== 200) throw new OutcomeError({ kind: "retry", code: `guest-http-${answer.status}` });
        const link = (answer.body as { link?: unknown } | null)?.link;
        if (typeof link === "string") this.#options.onPersonalLink(link);
      })
      .catch((error: unknown) => {
        this.#guest = null;
        throw error;
      });
    return this.#guest;
  }

  /**
   * Whether the same file (by fingerprint) is already on its way: sending, or waiting to try again
   * by itself. The same file picked again after it failed takes the failed row's place.
   */
  #isDuplicate(run: Run): boolean {
    for (const other of [...this.#runs.values()]) {
      if (other === run || other.cancelled || other.fingerprint !== run.fingerprint || other.file.size !== run.file.size) continue;
      const item = this.#store.get(other.itemId);
      if (this.#active.has(other.itemId) || (item && item.status !== "failed")) return true;
      this.#store.remove(other.itemId);
      this.#runs.delete(other.itemId);
    }
    return false;
  }

  /**
   * A file this phone has asked to complete before (its answer lost, or picked again later): asks
   * the server whether that upload is done, rather than sending it again. True when that settles it.
   */
  async #settledBefore(run: Run): Promise<boolean> {
    const fingerprint = run.fingerprint as string;
    const mediaId = this.#sentFiles.find(run.file.size, fingerprint);
    if (!mediaId) return false;
    this.#store.update(run.itemId, { mediaId });
    const answer = await this.#api.request(`/api/uploads/${mediaId}/complete`, {
      method: "POST",
      body: { parts: [] },
      timeoutMs: TIMEOUTS.complete,
      signal: run.abort.signal,
    });
    if (run.cancelled) return true;
    const outcome = probeOutcome(answer);
    switch (outcome.kind) {
      case "added":
        this.#added(run);
        return true;
      case "failed":
        this.#failed(run, outcome);
        return true;
      case "retry":
        throw new OutcomeError(outcome);
      case "forget":
        this.#sentFiles.forget(run.file.size, fingerprint);
        this.#store.update(run.itemId, { mediaId: null });
        return false;
      case "continue":
        return false;
    }
  }

  /** POST /api/uploads: a new upload, or this guest's unfinished one of the same file, with its parts so far. */
  async #start(run: Run): Promise<void> {
    const item = this.#store.get(run.itemId);
    if (!item) throw new DOMException("The file left the card", "AbortError");
    const answer = await this.#api.request("/api/uploads", {
      method: "POST",
      body: {
        purpose: "album",
        filename: run.file.name,
        size: run.file.size,
        contentType: item.contentType,
        fingerprint: run.fingerprint,
        capturedAt: run.file.lastModified > 0 ? new Date(run.file.lastModified).toISOString() : null,
        uploaderName: this.#options.guestName() ?? undefined,
      },
      timeoutMs: TIMEOUTS.start,
      signal: run.abort.signal,
    });
    const outcome = startOutcome(answer);
    if (outcome.kind !== "session") {
      // The browser lost its guest meanwhile: ask for one again before the next try.
      if (outcome.kind === "retry" && outcome.code === "no-guest") this.#guest = null;
      throw new OutcomeError(outcome);
    }
    const { session } = outcome;
    run.session = session;
    run.startParts = session.uploadedParts;
    run.partUrls = this.#partUrlsFor(run, session.uploadedParts.map((part) => part.partNumber));
    this.#store.update(run.itemId, { mediaId: session.mediaId });
    if (run.cancelled) void this.#cancelOnServer(run, session.mediaId);
  }

  #partUrlsFor(run: Run, uploadedParts: number[]): PartUrlCache {
    const session = run.session as UploadSession;
    return new PartUrlCache({
      partCount: session.partCount,
      uploadedParts,
      fetchUrls: async (partNumbers, signal) => {
        const answer = await this.#api.request(`/api/uploads/${session.mediaId}/parts`, {
          method: "POST",
          body: { partNumbers },
          timeoutMs: TIMEOUTS.parts,
          signal,
        });
        const outcome = partsOutcome(answer);
        if (outcome.kind === "ok") return (outcome.body as { urls: PartUrl[] }).urls;
        // Signing can't succeed (closed, expired, finished): end the file now, not after Uppy's retries.
        if (outcome.kind === "failed") this.#giveUp(run, new OutcomeError(outcome));
        throw new OutcomeError(outcome);
      },
    });
  }

  /** Hands the file to Uppy, restoring its upload, and waits for Uppy's success or error. */
  #send(run: Run): Promise<void> {
    const session = run.session as UploadSession;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      run.settle = {
        resolve: () => {
          if (!done) resolve();
          done = true;
        },
        reject: (error) => {
          if (!done) reject(error);
          done = true;
        },
      };
      const fileId = this.#uppy.addFile({
        name: run.file.name,
        type: this.#store.get(run.itemId)?.contentType,
        data: run.file,
        // relativePath makes Uppy's own id for the file unique to this item.
        meta: { itemId: run.itemId, relativePath: run.itemId },
        source: "nona",
      });
      run.uppyFileId = fileId;
      this.#uppy.setFileState(fileId, { s3Multipart: { uploadId: session.uploadId, key: session.key } } as Partial<EngineFile>);
      // Only the file just added is waiting, so this upload() takes it alone.
      this.#uppy.upload().catch(() => {});
    });
  }

  /** Uppy's upload-success (error null) or upload-error for a file: settles its run, and the file leaves Uppy. */
  #settled(file: EngineFile | undefined, error: unknown): void {
    const run = file && this.#runs.get(file.meta.itemId);
    if (!run || run.uppyFileId !== file.id) return;
    // At once, before any other upload() could pick a failed file up to retry it Uppy's way.
    this.#leaveUppy(run);
    if (error) run.settle?.reject(error);
    else run.settle?.resolve();
  }

  /** Ends the attempt now with `error` (signing it can't succeed), rather than after Uppy's retries. */
  #giveUp(run: Run, error: OutcomeError): void {
    this.#leaveUppy(run);
    run.settle?.reject(error);
  }

  #leaveUppy(run: Run): void {
    const fileId = run.uppyFileId;
    run.uppyFileId = null;
    if (fileId && this.#uppy.getFile(fileId)) this.#uppy.removeFile(fileId);
  }

  // ---------- Uppy's callbacks ----------

  async #listParts(file: EngineFile, signal: AbortSignal | undefined): Promise<AwsS3Part[]> {
    const run = this.#runOfFile(file);
    if (run.startParts) {
      const parts = run.startParts;
      run.startParts = null;
      return parts.map(toS3Part);
    }
    const session = run.session as UploadSession;
    const outcome = partsOutcome(
      await this.#api.request(`/api/uploads/${session.mediaId}/parts`, { method: "GET", timeoutMs: TIMEOUTS.parts, signal }),
    );
    if (outcome.kind !== "ok") throw new OutcomeError(outcome);
    // A finished upload lists every part with an empty ETag: Uppy skips them all and completes.
    const parts = (outcome.body as { parts: UploadSession["uploadedParts"] }).parts;
    run.partUrls = this.#partUrlsFor(run, parts.map((part) => part.partNumber));
    return parts.map(toS3Part);
  }

  async #signPart(file: EngineFile, partNumber: number, signal: AbortSignal | undefined): Promise<AwsS3UploadParameters> {
    const run = this.#runOfFile(file);
    if (!run.partUrls) throw new Error("The upload hasn't started");
    const attempt = (run.partAttempts.get(partNumber) ?? 0) + 1;
    run.partAttempts.set(partNumber, attempt);
    const url = await run.partUrls.urlFor(partNumber, signal);
    this.#partOfUrl.set(url, { itemId: run.itemId, partNumber, attempt });
    // A plain PUT of the part's bytes: no headers, so R2 takes the metadata the server set.
    return { method: "PUT", url };
  }

  /** One part's PUT (Uppy's own), dropped and retried after a minute without progress, and reported when it fails. */
  async #putPart(options: Parameters<typeof AwsS3.uploadPartBytes>[0]) {
    const part = this.#partOfUrl.get(options.signature.url);
    this.#partOfUrl.delete(options.signature.url);
    const controller = new AbortController();
    const outer = options.signal;
    const onAbort = () => controller.abort(outer?.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    let stalled = false;
    const stall = () => {
      stalled = true;
      controller.abort();
    };
    let stallTimer = setTimeout(stall, PART_STALL_MILLISECONDS);
    const startedAt = Date.now();
    try {
      return await AwsS3.uploadPartBytes({
        ...options,
        signal: controller.signal,
        onProgress: (event: ProgressEvent) => {
          clearTimeout(stallTimer);
          stallTimer = setTimeout(stall, PART_STALL_MILLISECONDS);
          options.onProgress(event);
        },
      });
    } catch (error) {
      if (outer?.aborted) throw error;
      // A stalled part looks like a dropped connection to Uppy, which then sends it again.
      const failure = stalled ? Object.assign(new Error("The part stalled"), { source: { status: 0 } }) : error;
      if (part) this.#partFailed(part, failure, Date.now() - startedAt, stalled);
      throw failure;
    } finally {
      clearTimeout(stallTimer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  #partFailed(part: { itemId: string; partNumber: number; attempt: number }, error: unknown, elapsedMs: number, stalled: boolean): void {
    const run = this.#runs.get(part.itemId);
    if (!run || run.cancelled) return;
    const status = Number((error as { source?: { status?: unknown } } | null)?.source?.status) || 0;
    this.#store.update(part.itemId, { status: "retrying" });
    this.#events.report({
      kind: "part-retry",
      mediaId: run.session?.mediaId,
      reason: stalled ? "stalled" : status > 0 ? `http-${status}` : "network-error",
      detail: {
        partNumber: part.partNumber,
        attempt: part.attempt,
        httpStatus: status > 0 ? status : undefined,
        online: typeof navigator === "undefined" ? undefined : navigator.onLine,
        elapsedMs: Math.round(elapsedMs),
      },
    });
  }

  /**
   * Every part is in R2: asks the server to verify and complete the upload. Only its "uploaded"
   * makes the file Added. The file is remembered first, so a lost answer can't send it twice.
   */
  async #complete(file: EngineFile, parts: AwsS3Part[], signal: AbortSignal | undefined): Promise<FileBody> {
    const run = this.#runOfFile(file);
    const session = run.session as UploadSession;
    this.#store.update(run.itemId, { status: "confirming", percent: 100 });
    if (run.fingerprint) this.#sentFiles.remember(run.file.size, run.fingerprint, session.mediaId);
    const answer = await this.#api.request(`/api/uploads/${session.mediaId}/complete`, {
      method: "POST",
      body: { parts: parts.map((sent) => ({ partNumber: sent.PartNumber, etag: sent.ETag ?? "" })) },
      timeoutMs: TIMEOUTS.complete,
      signal,
    });
    const outcome = completionOutcome(answer);
    if (outcome.kind === "added") return {};
    throw new OutcomeError(outcome);
  }

  // ---------- How a file ends ----------

  #added(run: Run): void {
    this.#store.update(run.itemId, { status: "added", percent: 100, failure: null });
    this.#runs.delete(run.itemId);
  }

  #failed(run: Run, outcome: Extract<Outcome, { kind: "failed" }>): void {
    this.#store.update(run.itemId, { status: "failed", failure: outcome.failure });
    this.#events.report({
      kind: "failed",
      mediaId: run.session?.mediaId,
      reason: outcome.code,
      detail: { online: typeof navigator === "undefined" ? undefined : navigator.onLine },
    });
    if (!outcome.failure.canRetry) this.#runs.delete(run.itemId);
  }

  /** Passing trouble: the file starts again by itself after a wait (offline, once back online), for about five minutes. */
  #retryLater(run: Run, outcome: Extract<Outcome, { kind: "retry" }>): void {
    if (!isOffline() && run.autoRetries >= FILE_RETRY_DELAYS_MILLISECONDS.length) {
      this.#failed(run, { kind: "failed", code: outcome.code, failure: { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true } });
      return;
    }
    const delay = FILE_RETRY_DELAYS_MILLISECONDS[Math.min(run.autoRetries, FILE_RETRY_DELAYS_MILLISECONDS.length - 1)];
    if (!isOffline()) run.autoRetries += 1;
    run.retryAt = Date.now() + delay;
    this.#store.update(run.itemId, { status: "retrying" });
  }

  /**
   * The guest's Cancel, on the server: DELETE ends an unfinished upload. One that already arrived
   * (a complete that won the race) answers 409 already-uploaded, so it is removed instead, as
   * "Remove my upload" does: the guest's wish holds either way. Tried a few times if the phone is
   * offline; it never shows.
   */
  async #cancelOnServer(run: Run, mediaId: string): Promise<void> {
    if (run.fingerprint) this.#sentFiles.forget(run.file.size, run.fingerprint);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const cancelled = await this.#api.request(`/api/uploads/${mediaId}`, { method: "DELETE", timeoutMs: TIMEOUTS.cancel });
        const code = (cancelled.body as { error?: unknown } | null)?.error;
        if (cancelled.status === 409 && code === "already-uploaded") {
          const removed = await this.#api.request(`/api/media/${mediaId}/remove`, { method: "POST", timeoutMs: TIMEOUTS.cancel });
          if (removed.status < 500) return;
        } else if (cancelled.status < 500) {
          return;
        }
      } catch {
        // No answer: try again below.
      }
      if (attempt >= CANCEL_RETRY_DELAYS_MILLISECONDS.length) {
        this.#events.report({ kind: "failed", mediaId, reason: "cancel-unanswered" });
        return;
      }
      await sleep(CANCEL_RETRY_DELAYS_MILLISECONDS[attempt]);
    }
  }
}

/** The uploader for the album page's store. */
export function startEngine(store: UploadStore, options: EngineOptions): Engine {
  return new UploadEngine(store, options);
}
