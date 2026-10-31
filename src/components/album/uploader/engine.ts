import AwsS3, { type AwsS3Part, type AwsS3UploadParameters } from "@uppy/aws-s3";
import Uppy, { type UppyFile } from "@uppy/core";
import { createApiClient, type ApiAnswer, type ApiClient } from "./api";
import { EventReporter } from "./events";
import {
  browserStorage,
  createPendingCancels,
  createStartedFiles,
  type PendingCancels,
  type StartedFiles,
  type StorageLike,
} from "./local-records";
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
import { createPartPut, type PartPut, type PartPutResult } from "./part-put";
import { PartUrlCache, type PartUrl } from "./presign-cache";
import { createSentFiles, fingerprintFile, type SentFiles } from "./resume";
import { UPLOAD_WORDS, type UploadFailure, type UploadStore } from "./state";

/*
 * The uploader: every file a presigned multipart upload straight to R2, in the parts the server
 * names, through Uppy 5's @uppy/aws-s3, with the site's own API for each step. Loaded apart from
 * the album page (load.ts). Uppy 5's traps, and how each is met:
 * - It would create the multipart upload itself. Instead the uploader awaits POST /api/guest once,
 *   fingerprints the file and calls POST /api/uploads first (which resumes this guest's unfinished
 *   upload of the same file, renamed or not), then sets the file's s3Multipart state, so Uppy
 *   takes its "restoring" path: it lists the parts R2 already holds (the start's own list, the
 *   first time) and sends only the rest. createMultipartUpload only returns that state.
 * - It aborts the multipart upload on any final error, which would lose every part sent. Its
 *   abortMultipartUpload does nothing: only the guest's Cancel ends an upload, through DELETE
 *   /api/uploads/[id] (and "Remove my upload" when that answers already-uploaded), kept in
 *   localStorage until the server answers, and sent again on the next visit if it never does.
 * - Its upload() retries every failed file it still holds, its own way. A file leaves Uppy as soon
 *   as it succeeds or fails; Try again runs it through this same path.
 * - It signs each part with its own call. signPart reads presign-cache.ts, 20 parts a call.
 * - Its own part PUT hangs for good when the ETag can't be read, and never times out: the PUT is
 *   done by part-put.ts, which resolves without an ETag and drops a part after a minute stalled.
 * Files go two at a time and parts four at a time (Uppy's limit, across files). A part that fails
 * is retried by Uppy with backoff; a file whose trouble outlasts that (no signal for a while) tries
 * again by itself for about five minutes (offline time not counted), then waits for the guest's
 * Try again. A file shows "Added" only once its complete answers that the server verified it.
 */

/** Files sent at once (gate A: two at a time). */
export const FILES_IN_FLIGHT = 2;
const PARTS_IN_FLIGHT = 4;

export type UploadTimings = {
  /** Uppy's waits before each retry of a part's PUT, or of signing it. */
  partRetryDelays: number[];
  /** A file's own waits before it starts again by itself: about five minutes in all. */
  fileRetryDelays: number[];
  /** A Cancel's waits before it is sent again, once online; past these the guest is told. */
  cancelRetryDelays: number[];
  /** How long a file may take to open for its fingerprint (one in the cloud downloads first). */
  fingerprintTimeoutMs: number;
};

export const UPLOAD_TIMINGS: UploadTimings = {
  partRetryDelays: [0, 1_000, 3_000, 5_000, 10_000],
  fileRetryDelays: [3_000, 10_000, 20_000, 30_000, 45_000, 60_000, 60_000, 60_000],
  cancelRetryDelays: [2_000, 5_000, 10_000, 20_000],
  fingerprintTimeoutMs: 60_000,
};

/** Each call's timeout. A complete may take the server up to 40 s (its R2 budget). */
const TIMEOUTS = { guest: 10_000, start: 20_000, parts: 15_000, complete: 60_000, cancel: 20_000 };
/** S3's smallest part but the last: a session naming a smaller one is not the server's. */
const MIN_PART_BYTES = 5 * 1024 * 1024;

type FileMeta = { itemId: string; relativePath: string };
type FileBody = Record<string, never>;
type EngineFile = UppyFile<FileMeta, FileBody>;

/** Where the uploader hears that the phone is back online or the page is going. */
export type EngineEnvironment = {
  onOnline(listener: () => void): void;
  onPageHide(listener: () => void): void;
  isOffline(): boolean;
};

const browserEnvironment: EngineEnvironment = {
  onOnline: (listener) => window.addEventListener("online", listener),
  onPageHide: (listener) => window.addEventListener("pagehide", listener),
  isOffline: () => typeof navigator !== "undefined" && navigator.onLine === false,
};

/** What a test can stand in for: the site's API, the part PUT, storage, the network's state and the waits. */
export type EngineDependencies = {
  api?: ApiClient;
  putPart?: PartPut;
  storage?: StorageLike | null;
  environment?: EngineEnvironment;
  timings?: Partial<UploadTimings>;
};

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
  /** Which part each link handed out is for, so a failed PUT can say; cleared with each attempt. */
  partOfUrl: Map<string, { partNumber: number; attempt: number }>;
  partAttempts: Map<number, number>;
  autoRetries: number;
  retryAt: number;
  bytesSent: number;
  cancelled: boolean;
  /** The guest's Cancel is on its way to the server. */
  cancelInFlight: boolean;
  /** A Cancel went to the server: from then on, the Cancel's outcome decides what the card shows. */
  cancelSent: boolean;
  /** Asking the server about a file this phone sent before: a Cancel now only stops this copy. */
  probing: boolean;
};

/** What a Cancel's request came to: done; refused (403: the upload isn't this browser's guest's any more); or no answer. */
type CancelResult = "done" | "refused" | "unanswered";

export type EngineOptions = {
  /** The guest's name on this phone, sent with their guest and each upload. */
  guestName: () => string | null;
  /** Called with the guest's personal link once POST /api/guest answers. */
  onPersonalLink: (link: string) => void;
};

export type Engine = {
  /** Starts the queued files, up to two at a time. */
  pump(): void;
  /** Try again: sends a failed file again through the same path (or, for a Cancel never answered, the Cancel). */
  retry(itemId: string): void;
  /** Cancel: stops the file and ends its upload on the server (removing it if it already arrived). */
  cancel(itemId: string): void;
  /** Takes a failed file off the card (a Cancel never answered is still sent on the next visit). */
  dismiss(itemId: string): void;
  /** Sends again the Cancels an earlier visit couldn't get answered. */
  replayPendingCancels(): Promise<void>;
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const isSuccess = (answer: ApiAnswer) => answer.status >= 200 && answer.status < 300;

function toS3Part(part: { partNumber: number; etag: string; size: number }): AwsS3Part {
  return { PartNumber: part.partNumber, ETag: part.etag, Size: part.size };
}

function failedOutcome(code: string, failure: UploadFailure): Extract<Outcome, { kind: "failed" }> {
  return { kind: "failed", code, failure };
}

class UploadEngine implements Engine {
  readonly #store: UploadStore;
  readonly #options: EngineOptions;
  readonly #api: ApiClient;
  readonly #putPartBytes: PartPut;
  readonly #environment: EngineEnvironment;
  readonly #timings: UploadTimings;
  readonly #events: EventReporter;
  readonly #sentFiles: SentFiles;
  readonly #startedFiles: StartedFiles;
  readonly #pendingCancels: PendingCancels;
  readonly #uppy: Uppy<FileMeta, FileBody>;
  readonly #runs = new Map<string, Run>();
  readonly #active = new Set<string>();
  readonly #replaying = new Set<string>();
  readonly #onlineWaiters: (() => void)[] = [];
  #guest: Promise<void> | null = null;
  #pumpTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: UploadStore, options: EngineOptions, dependencies: EngineDependencies) {
    this.#store = store;
    this.#options = options;
    this.#api = dependencies.api ?? createApiClient();
    this.#putPartBytes = dependencies.putPart ?? createPartPut();
    this.#environment = dependencies.environment ?? browserEnvironment;
    this.#timings = { ...UPLOAD_TIMINGS, ...dependencies.timings };
    const storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
    this.#sentFiles = createSentFiles(storage);
    this.#startedFiles = createStartedFiles(storage);
    this.#pendingCancels = createPendingCancels(storage);
    this.#events = new EventReporter(this.#api, this.#environment.onPageHide);
    this.#uppy = new Uppy<FileMeta, FileBody>({ id: "nona-album", autoProceed: false, allowMultipleUploadBatches: true });
    this.#uppy.use(AwsS3<FileMeta, FileBody>, {
      shouldUseMultipart: true,
      limit: PARTS_IN_FLIGHT,
      retryDelays: this.#timings.partRetryDelays,
      // The parts the server named for this upload (it binds each part URL to its size).
      getChunkSize: (data) => {
        const session = this.#runOfData(data)?.session;
        if (!session) throw new Error("The upload hasn't started");
        return session.partSize;
      },
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
    this.#environment.onOnline(() => {
      for (const waiter of this.#onlineWaiters.splice(0)) waiter();
      this.pump();
    });
  }

  // ---------- The queue ----------

  pump(): void {
    clearTimeout(this.#pumpTimer);
    if (this.#environment.isOffline()) return;
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
    const mediaId = run?.session?.mediaId ?? item.mediaId;
    if (item.failure.cancelFailed && run && mediaId) {
      this.#store.update(itemId, { status: "cancelling", failure: null });
      void this.#cancelOnServer(run, mediaId);
      return;
    }
    if (run) {
      run.autoRetries = 0;
      run.retryAt = 0;
      // A file the phone couldn't read, or took too long to open, is read afresh.
      if (item.failure.reason === UPLOAD_WORDS.unreadable || item.failure.reason === UPLOAD_WORDS.slowToOpen) run.fingerprint = null;
    }
    this.#store.update(itemId, { status: "queued", failure: null });
    this.pump();
  }

  cancel(itemId: string): void {
    const item = this.#store.get(itemId);
    if (!item || item.status === "added" || item.status === "cancelling") return;
    const run = this.#runs.get(itemId);
    if (!run) {
      // Never started: nothing to tell the server.
      this.#store.remove(itemId);
      return;
    }
    // While the server is asked about a file this phone sent before, and this copy has no upload of
    // its own, Cancel means "stop this copy", never "take my photo out of the album": that stays
    // Remove my upload's, a deliberate act. A copy that has its own upload (its complete's answer
    // lost, now asked about) cancels that upload, as any Cancel does.
    const mediaId = run.probing && !run.session ? null : (run.session?.mediaId ?? item.mediaId);
    run.cancelled = true;
    this.#leaveUppy(run);
    run.settle?.reject(new DOMException("The guest cancelled", "AbortError"));
    this.#store.update(itemId, { status: "cancelling" });
    if (mediaId) {
      void this.#cancelOnServer(run, mediaId);
    } else if (!this.#active.has(itemId)) {
      this.#store.remove(itemId);
      this.#runs.delete(itemId);
    }
    // Otherwise it is being asked about, or its start is on its way: #start cancels the upload once
    // the server names it, or, if it never does, #run's end takes the file away.
  }

  dismiss(itemId: string): void {
    const item = this.#store.get(itemId);
    if (!item || item.status !== "failed") return;
    this.#store.remove(itemId);
    // Gone for good, even while a start is still on its way: #run holds its own run to finish with,
    // and a Cancel still owed is sent again then (or on the next visit), with nothing on the card.
    this.#runs.delete(itemId);
  }

  async replayPendingCancels(): Promise<void> {
    const pending = this.#pendingCancels.list().filter((cancel) => !this.#replaying.has(cancel.mediaId));
    await Promise.all(
      pending.map(async ({ mediaId }) => {
        this.#replaying.add(mediaId);
        try {
          // Unanswered again, it stays for the next visit; done or refused, it is dropped.
          if ((await this.#sendCancel(mediaId)) !== "unanswered") this.#pendingCancels.remove(mediaId);
        } finally {
          this.#replaying.delete(mediaId);
        }
      }),
    );
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
        partOfUrl: new Map(),
        partAttempts: new Map(),
        autoRetries: 0,
        retryAt: 0,
        bytesSent: 0,
        cancelled: false,
        cancelInFlight: false,
        cancelSent: false,
        probing: false,
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

  #runOfData(data: unknown): Run | undefined {
    for (const run of this.#runs.values()) if (run.file === data) return run;
    return undefined;
  }

  async #run(itemId: string): Promise<void> {
    const item = this.#store.get(itemId);
    if (!item) {
      this.#active.delete(itemId);
      return;
    }
    const run = this.#runOf(itemId, item.file);
    run.retryAt = 0;
    run.partOfUrl.clear();
    this.#store.update(itemId, { status: "sending", failure: null });
    try {
      await this.#ensureGuest();
      if (run.cancelled) return;
      run.fingerprint ??= await this.#fingerprint(run.file);
      if (run.cancelled) return;
      if (this.#isDuplicate(run)) {
        // The same file picked twice while the first is still on its way: the first one carries it.
        this.#store.remove(itemId);
        this.#runs.delete(itemId);
        return;
      }
      if (await this.#settledBefore(run)) return;
      if (run.cancelled) return;
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
      // Cancelled before the server knew of it, and no Cancel sent: nothing to show. A Cancel that
      // was sent decides for itself, its failure staying on the card.
      if (run.cancelled && !run.cancelSent && !run.session) {
        this.#store.remove(itemId);
        this.#runs.delete(itemId);
      }
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

  /** The file's fingerprint, or a plain failure (with Try again) when it takes over a minute to open. */
  #fingerprint(file: File): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new OutcomeError(failedOutcome("slow-to-open", { reason: UPLOAD_WORDS.slowToOpen, hint: null, canRetry: true })),
          ),
        this.#timings.fingerprintTimeoutMs,
      );
      fingerprintFile(file).then(
        (fingerprint) => {
          clearTimeout(timer);
          resolve(fingerprint);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
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
    run.probing = true;
    let answer: ApiAnswer;
    try {
      answer = await this.#api.request(`/api/uploads/${mediaId}/complete`, {
        method: "POST",
        body: { parts: [] },
        timeoutMs: TIMEOUTS.complete,
      });
    } finally {
      run.probing = false;
    }
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
        // Gone, or removed by the guest, who picking it again wants it back: send it afresh.
        this.#sentFiles.forget(run.file.size, fingerprint);
        this.#store.update(run.itemId, { mediaId: null });
        return false;
      case "continue":
        return false;
    }
  }

  /**
   * POST /api/uploads: a new upload, or this guest's unfinished one of the same file, with its
   * parts so far. Sent without the Cancel's signal: a start the guest cancels still answers, so
   * the upload it made can be cancelled on the server rather than left behind.
   */
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
    });
    const outcome = startOutcome(answer);
    if (outcome.kind !== "session") {
      // The browser lost its guest meanwhile: ask for one again before the next try.
      if (outcome.kind === "retry" && outcome.code === "no-guest") this.#guest = null;
      throw new OutcomeError(outcome);
    }
    const { session } = outcome;
    // The parts must be the ones the server binds each URL to: a session that disagrees with
    // itself is not the server's answer.
    const partsAgree =
      Number.isInteger(session.partSize) &&
      session.partSize >= MIN_PART_BYTES &&
      session.partCount === Math.ceil(run.file.size / session.partSize);
    if (!partsAgree) {
      throw new OutcomeError(failedOutcome("unexpected-answer", { reason: UPLOAD_WORDS.notSent, hint: null, canRetry: true }));
    }
    // Nothing in R2 yet (a new upload, or one started again after it expired): the bar starts again.
    if (session.uploadedParts.length === 0) {
      run.bytesSent = 0;
      this.#store.update(run.itemId, { percent: 0 });
    }
    run.session = session;
    run.startParts = session.uploadedParts;
    run.partUrls = this.#partUrlsFor(run, session.uploadedParts.map((part) => part.partNumber));
    this.#store.update(run.itemId, { mediaId: session.mediaId });
    this.#startedFiles.record(run.file.size, run.fingerprint as string, session.mediaId);
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
    // Links handed out for PUTs that will now never start.
    run.partOfUrl.clear();
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
    run.partOfUrl.set(url, { partNumber, attempt });
    // A plain PUT of the part's bytes: no headers, so R2 takes the metadata the server set.
    return { method: "PUT", url };
  }

  /** One part's PUT (part-put.ts), reported when it fails for a reason other than the guest's. */
  async #putPart(options: Parameters<typeof AwsS3.uploadPartBytes>[0]): Promise<PartPutResult> {
    const { url } = options.signature;
    let run: Run | undefined;
    for (const candidate of this.#runs.values()) if (candidate.partOfUrl.has(url)) run = candidate;
    const part = run?.partOfUrl.get(url);
    run?.partOfUrl.delete(url);
    const startedAt = Date.now();
    try {
      return await this.#putPartBytes({
        signature: options.signature,
        body: options.body,
        size: options.size,
        onProgress: options.onProgress,
        onComplete: options.onComplete,
        signal: options.signal,
      });
    } catch (error) {
      if (!options.signal?.aborted && run && part) this.#partFailed(run, part, error, Date.now() - startedAt);
      throw error;
    }
  }

  #partFailed(run: Run, part: { partNumber: number; attempt: number }, error: unknown, elapsedMs: number): void {
    if (run.cancelled) return;
    const failure = error as { stalled?: unknown; source?: { status?: unknown } } | null;
    const status = Number(failure?.source?.status) || 0;
    this.#store.update(run.itemId, { status: "retrying" });
    this.#events.report({
      kind: "part-retry",
      mediaId: run.session?.mediaId,
      reason: failure?.stalled ? "stalled" : status > 0 ? `http-${status}` : "network-error",
      detail: {
        partNumber: part.partNumber,
        attempt: part.attempt,
        httpStatus: status > 0 ? status : undefined,
        online: !this.#environment.isOffline(),
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
    if (run.fingerprint) this.#startedFiles.finish(run.file.size, run.fingerprint);
    this.#runs.delete(run.itemId);
  }

  #failed(run: Run, outcome: Extract<Outcome, { kind: "failed" }>): void {
    this.#store.update(run.itemId, { status: "failed", failure: outcome.failure });
    this.#events.report({
      kind: "failed",
      mediaId: run.session?.mediaId,
      reason: outcome.code,
      detail: { online: !this.#environment.isOffline() },
    });
    if (!outcome.failure.canRetry) {
      if (run.fingerprint) this.#startedFiles.finish(run.file.size, run.fingerprint);
      this.#runs.delete(run.itemId);
    }
  }

  /** Passing trouble: the file starts again by itself after a wait (offline, once back online), for about five minutes. */
  #retryLater(run: Run, outcome: Extract<Outcome, { kind: "retry" }>): void {
    const delays = this.#timings.fileRetryDelays;
    const offline = this.#environment.isOffline();
    if (!offline && run.autoRetries >= delays.length) {
      this.#failed(run, failedOutcome(outcome.code, { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true }));
      return;
    }
    const delay = delays[Math.min(run.autoRetries, delays.length - 1)] ?? 0;
    if (!offline) run.autoRetries += 1;
    run.retryAt = Date.now() + delay;
    this.#store.update(run.itemId, { status: "retrying" });
  }

  // ---------- Cancel ----------

  /**
   * The guest's Cancel, on the server. It is kept in localStorage until the server answers, so a
   * Cancel the phone couldn't send is sent again on the next visit (for up to seven days); and
   * should it go unanswered here, or be refused, the file comes back to the card saying so, with Try
   * again. Never dropped silently. A refusal (403: the browser no longer holds the upload's guest)
   * isn't kept to send again, as no later visit could do better.
   */
  async #cancelOnServer(run: Run, mediaId: string): Promise<void> {
    if (run.cancelInFlight) return;
    run.cancelInFlight = true;
    run.cancelSent = true;
    this.#pendingCancels.add(mediaId, run.session?.uploadId ?? null);
    if (run.fingerprint) {
      this.#sentFiles.forget(run.file.size, run.fingerprint);
      this.#startedFiles.finish(run.file.size, run.fingerprint);
    }
    this.#startedFiles.forgetMedia(mediaId);
    const result = await this.#sendCancel(mediaId);
    run.cancelInFlight = false;
    // Refused (403), no later visit could do better: it isn't kept to send again.
    if (result !== "unanswered") this.#pendingCancels.remove(mediaId);
    if (result === "done") {
      this.#store.remove(run.itemId);
      this.#runs.delete(run.itemId);
      return;
    }
    this.#store.update(run.itemId, {
      status: "failed",
      failure: { reason: UPLOAD_WORDS.cancelUnanswered, hint: null, canRetry: true, cancelFailed: true },
    });
    this.#events.report({ kind: "failed", mediaId, reason: result === "refused" ? "cancel-refused" : "cancel-unanswered" });
  }

  /**
   * Sends a Cancel until it is done or refused, or its tries run out; offline, it waits to be back
   * online, uncounted.
   */
  async #sendCancel(mediaId: string): Promise<CancelResult> {
    const delays = this.#timings.cancelRetryDelays;
    for (let attempt = 0; ; ) {
      await this.#whenOnline();
      const result = await this.#cancelOnce(mediaId);
      if (result !== "unanswered") return result;
      if (this.#environment.isOffline()) continue;
      if (attempt >= delays.length) return "unanswered";
      await sleep(delays[attempt]);
      attempt += 1;
    }
  }

  /**
   * One Cancel: done when DELETE answers 2xx, or 404 (gone already: an earlier Cancel went through),
   * or 409 already-uploaded and then Remove answers 2xx or 404. Refused when either answers 403: the
   * browser no longer holds the upload's guest. Anything else is no answer.
   */
  async #cancelOnce(mediaId: string): Promise<CancelResult> {
    try {
      const cancelled = await this.#api.request(`/api/uploads/${mediaId}`, { method: "DELETE", timeoutMs: TIMEOUTS.cancel });
      if (isSuccess(cancelled) || cancelled.status === 404) return "done";
      if (cancelled.status === 403) return "refused";
      const code = (cancelled.body as { error?: unknown } | null)?.error;
      if (cancelled.status !== 409 || code !== "already-uploaded") return "unanswered";
      const removed = await this.#api.request(`/api/media/${mediaId}/remove`, { method: "POST", timeoutMs: TIMEOUTS.cancel });
      if (isSuccess(removed) || removed.status === 404) return "done";
      return removed.status === 403 ? "refused" : "unanswered";
    } catch {
      return "unanswered";
    }
  }

  #whenOnline(): Promise<void> {
    if (!this.#environment.isOffline()) return Promise.resolve();
    return new Promise((resolve) => this.#onlineWaiters.push(resolve));
  }
}

/** The uploader for the album page's store. */
export function startEngine(store: UploadStore, options: EngineOptions, dependencies: EngineDependencies = {}): Engine {
  return new UploadEngine(store, options, dependencies);
}
