import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "./api";
import { startEngine, UPLOAD_TIMINGS, type Engine, type EngineEnvironment } from "./engine";
import { createPendingCancels, createStartedFiles, type StorageLike } from "./local-records";
import type { PartPut } from "./part-put";
import { createSentFiles, fingerprintFile } from "./resume";
import { createUploadStore, UPLOAD_WORDS, type UploadItem, type UploadStore } from "./state";

/*
 * The uploader itself, with real Uppy, against a stand-in for the site's API and for R2's part
 * PUTs: what it sends, in which order, and what the guest sees.
 */

const MEBIBYTE = 1024 * 1024;

type ServerUpload = {
  mediaId: string;
  uploadId: string;
  size: number;
  fingerprint: string;
  parts: Set<number>;
  status: "uploading" | "uploaded";
  removed?: boolean;
  hidden?: boolean;
};

type Answer = { status: number; body?: unknown };

/** The site's upload API, in memory. Each `answer*` hook can stand in for one route. */
class FakeServer {
  readonly uploads = new Map<string, ServerUpload>();
  readonly calls: { method: string; path: string; body: unknown }[] = [];
  partSize = 8 * MEBIBYTE;
  /** Wrong part counts in the start's answer. */
  partCountOff = 0;
  /** Every call fails as a dropped connection while true. */
  down = false;
  /** Held completes wait for this: every one, or those from call `holdCompletesFrom` on. */
  completeGate: Promise<void> | null = null;
  holdCompletesFrom = 1;
  completeCalls = 0;
  /** This many complete answers are lost on the way back (the server did the work). */
  loseCompleteAnswers = 0;
  answerDelete: ((mediaId: string) => Answer) | null = null;
  answerRemove: ((mediaId: string) => Answer) | null = null;
  /** Held starts wait for this; `answerStart` answers in the server's place. */
  startGate: Promise<void> | null = null;
  answerStart: (() => Answer) | null = null;
  #made = 0;

  count(method: string, pattern: RegExp): number {
    return this.calls.filter((call) => call.method === method && pattern.test(call.path)).length;
  }

  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const path = String(input);
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    this.calls.push({ method, path, body });
    if (this.down) throw new TypeError("Failed to fetch");
    const answer = await this.#route(method, path, body);
    if (path.endsWith("/complete") && this.loseCompleteAnswers > 0) {
      this.loseCompleteAnswers -= 1;
      throw new TypeError("Failed to fetch");
    }
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;

  async #route(method: string, path: string, body: Record<string, unknown> | undefined): Promise<Answer> {
    if (path === "/api/guest") return { status: 200, body: { guestId: "guest-1", link: "https://example.com/my/token" } };
    if (path === "/api/upload-events") return { status: 200, body: { stored: 1 } };
    if (path === "/api/uploads" && method === "POST") {
      await this.startGate;
      if (this.answerStart) return this.answerStart();
      return this.#start(body as { size: number; fingerprint: string });
    }
    const match = /^\/api\/(uploads|media)\/([^/]+)(?:\/(parts|complete|remove))?$/.exec(path);
    if (!match) return { status: 404 };
    const [, , mediaId, action] = match;
    const upload = this.uploads.get(mediaId);
    if (action === "remove") {
      if (this.answerRemove) return this.answerRemove(mediaId);
      if (!upload) return { status: 404, body: { error: "not-found" } };
      upload.removed = true;
      return { status: 200, body: { mediaId, removed: true } };
    }
    if (method === "DELETE") {
      if (this.answerDelete) return this.answerDelete(mediaId);
      if (!upload) return { status: 404, body: { error: "not-found" } };
      if (upload.status !== "uploading") return { status: 409, body: { error: "already-uploaded" } };
      this.uploads.delete(mediaId);
      return { status: 200, body: { mediaId, cancelled: true } };
    }
    if (!upload) return { status: 403, body: { error: "forbidden" } };
    if (action === "parts" && method === "POST") {
      const partNumbers = (body as { partNumbers: number[] }).partNumbers;
      return { status: 200, body: { urls: partNumbers.map((partNumber) => ({ partNumber, url: `https://r2.test/${mediaId}/${partNumber}?n=${(this.#made += 1)}` })) } };
    }
    if (action === "parts") return { status: 200, body: { parts: this.#partsOf(upload) } };
    if (action === "complete") {
      this.completeCalls += 1;
      if (this.completeCalls >= this.holdCompletesFrom) await this.completeGate;
      if (upload.removed) return { status: 409, body: { error: "removed" } };
      if (upload.hidden) return { status: 409, body: { error: "hidden" } };
      if (upload.status !== "uploading") return { status: 200, body: { mediaId, status: upload.status } };
      if (upload.parts.size < Math.ceil(upload.size / this.partSize)) return { status: 409, body: { error: "incomplete" } };
      upload.status = "uploaded";
      return { status: 200, body: { mediaId, status: "uploaded" } };
    }
    return { status: 404 };
  }

  #partsOf(upload: ServerUpload) {
    return [...upload.parts].map((partNumber) => ({
      partNumber,
      etag: `"etag-${partNumber}"`,
      size: Math.min(this.partSize, upload.size - (partNumber - 1) * this.partSize),
    }));
  }

  #start({ size, fingerprint }: { size: number; fingerprint: string }): Answer {
    let upload = [...this.uploads.values()].find(
      (candidate) => candidate.status === "uploading" && candidate.size === size && candidate.fingerprint === fingerprint,
    );
    if (!upload) {
      this.#made += 1;
      upload = { mediaId: `media-${this.#made}`, uploadId: `upload-${this.#made}`, size, fingerprint, parts: new Set(), status: "uploading" };
      this.uploads.set(upload.mediaId, upload);
    }
    return {
      status: 200,
      body: {
        mediaId: upload.mediaId,
        uploadId: upload.uploadId,
        key: `originals/${upload.mediaId}.mp4`,
        partSize: this.partSize,
        partCount: Math.ceil(size / this.partSize) + this.partCountOff,
        uploadedParts: this.#partsOf(upload),
      },
    };
  }

  /** R2's part PUTs: each records its part, answers with no ETag the browser can read, and can be made to fail. */
  readonly puts: { mediaId: string; partNumber: number; size: number }[] = [];
  failPut: ((partNumber: number, attempt: number) => boolean) | null = null;
  holdPuts: Promise<void> | null = null;
  readonly putPart: PartPut = async (request) => {
    const [, mediaId, partText] = new URL(request.signature.url).pathname.split("/");
    const partNumber = Number(partText);
    const attempt = this.puts.filter((put) => put.mediaId === mediaId && put.partNumber === partNumber).length + 1;
    const size = (request.body as Blob).size;
    this.puts.push({ mediaId, partNumber, size });
    await this.holdPuts;
    if (request.signal?.aborted) throw new DOMException("stopped", "AbortError");
    if (this.failPut?.(partNumber, attempt)) throw Object.assign(new Error("The connection dropped"), { source: { status: 0 } });
    this.uploads.get(mediaId)?.parts.add(partNumber);
    request.onProgress?.({ loaded: size, lengthComputable: true });
    request.onComplete?.("");
    return { ETag: "" };
  };
}

function memoryStorage(): StorageLike {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

class FakeNetwork implements EngineEnvironment {
  offline = false;
  readonly #online: (() => void)[] = [];
  onOnline(listener: () => void) {
    this.#online.push(listener);
  }
  onPageHide() {}
  isOffline() {
    return this.offline;
  }
  backOnline() {
    this.offline = false;
    for (const listener of this.#online) listener();
  }
}

const engines: Engine[] = [];

function setUp(options: { storage?: StorageLike; server?: FakeServer } = {}) {
  const server = options.server ?? new FakeServer();
  const network = new FakeNetwork();
  const storage = options.storage ?? memoryStorage();
  const store = createUploadStore({ previews: { create: () => null, revoke: () => {} } });
  const engine = startEngine(
    store,
    { guestName: () => "Ama", onPersonalLink: () => {} },
    {
      api: createApiClient({ fetch: server.fetch, sleep: async () => {} }),
      putPart: server.putPart,
      storage,
      environment: network,
      timings: { partRetryDelays: [0, 0, 0], fileRetryDelays: [5, 5, 5], cancelRetryDelays: [5, 5], fingerprintTimeoutMs: 300 },
    },
  );
  engines.push(engine);
  const pick = (files: File[], source: "photo" | "video" | "gallery" = "gallery") => {
    const queued = store.add(files, source);
    engine.pump();
    return queued;
  };
  return { server, network, storage, store, engine, pick };
}

function video(size: number, name = "clip.mp4", fill = 7): File {
  return new File([new Uint8Array(size).fill(fill)], name, { type: "video/mp4" });
}

function itemOf(store: UploadStore, id: string): UploadItem | undefined {
  return store.get(id);
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the uploader");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(() => {
  engines.length = 0;
});

describe("the uploader", () => {
  it("sends a file in the parts the server names, none with a readable ETag, and adds it only on the complete's answer", async () => {
    const { server, store, pick } = setUp();
    server.partSize = 6 * MEBIBYTE;
    let release: () => void = () => {};
    server.completeGate = new Promise((resolve) => {
      release = resolve;
    });

    const [item] = pick([video(20 * MEBIBYTE)]);
    await until(() => itemOf(store, item.id)?.status === "confirming");
    expect(server.puts.map((put) => put.size)).toEqual([6, 6, 6, 2].map((mebibytes) => mebibytes * MEBIBYTE));
    expect(itemOf(store, item.id)).toMatchObject({ status: "confirming", percent: 100 });

    release();
    await until(() => itemOf(store, item.id)?.status === "added");
    expect(server.calls.filter((call) => call.path === "/api/guest")).toHaveLength(1);
  });

  it("refuses a session whose parts don't agree with themselves, plainly, with Try again", async () => {
    const { server, store, pick } = setUp();
    server.partCountOff = 1;

    const [item] = pick([video(3 * MEBIBYTE)]);
    await until(() => itemOf(store, item.id)?.status === "failed");
    expect(itemOf(store, item.id)?.failure).toEqual({ reason: UPLOAD_WORDS.notSent, hint: null, canRetry: true });
    expect(server.puts).toEqual([]);
  });

  it("sends again only the part whose connection dropped", async () => {
    const { server, store, pick } = setUp();
    server.failPut = (partNumber, attempt) => partNumber === 2 && attempt === 1;

    const [item] = pick([video(20 * MEBIBYTE)]);
    await until(() => itemOf(store, item.id)?.status === "added");
    expect(server.puts.map((put) => put.partNumber).sort()).toEqual([1, 2, 2, 3]);
  });

  it("carries one upload for the same file picked twice while it sends: the second row goes", async () => {
    const { server, store, pick } = setUp();
    let release: () => void = () => {};
    server.holdPuts = new Promise((resolve) => {
      release = resolve;
    });
    const file = video(MEBIBYTE);

    pick([file, file]);
    await until(() => store.getSnapshot().items.length === 1);
    release();
    await until(() => store.getSnapshot().items[0]?.status === "added");
    expect(server.count("POST", /^\/api\/uploads$/)).toBe(1);
    expect(server.puts).toHaveLength(1);
  });

  it("never sends a file twice when it is picked again after it was added: it is asked about instead", async () => {
    const { server, store, pick } = setUp();
    const file = video(MEBIBYTE);
    const [first] = pick([file]);
    await until(() => itemOf(store, first.id)?.status === "added");

    const [again] = pick([file]);
    await until(() => itemOf(store, again.id)?.status === "added");
    expect(server.count("POST", /^\/api\/uploads$/)).toBe(1);
    expect(server.puts).toHaveLength(1);
  });

  it("starts again by itself while the connection is down, then says the connection dropped, with Try again", async () => {
    const { server, store, engine, pick } = setUp();
    server.down = true;

    const [item] = pick([video(MEBIBYTE)]);
    await until(() => itemOf(store, item.id)?.status === "failed");
    expect(itemOf(store, item.id)?.failure).toEqual({ reason: "The connection dropped", hint: null, canRetry: true });
    // A guest call each time: the first try and three more of its own.
    expect(server.count("POST", /^\/api\/guest$/)).toBe(4 * 4);

    server.down = false;
    engine.retry(item.id);
    await until(() => itemOf(store, item.id)?.status === "added");
  });

  it("tries again by itself for about five minutes before it asks the guest", () => {
    const total = UPLOAD_TIMINGS.fileRetryDelays.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThanOrEqual(4 * 60_000);
    expect(total).toBeLessThanOrEqual(6 * 60_000);
  });

  it("says plainly when a file takes over a minute to open, with Try again that reads it afresh", async () => {
    const { store, engine, pick } = setUp();
    const neverOpens = {
      name: "cloud.mp4",
      type: "video/mp4",
      size: 4 * MEBIBYTE,
      lastModified: 0,
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(() => {}) }),
    } as unknown as File;

    const [item] = pick([neverOpens]);
    await until(() => itemOf(store, item.id)?.status === "failed");
    expect(itemOf(store, item.id)?.failure).toEqual({ reason: "This file took too long to open", hint: null, canRetry: true });
    engine.retry(item.id);
    expect(itemOf(store, item.id)?.status).not.toBe("failed");
  });
});

describe("a file this phone sent before, picked again", () => {
  async function remembered(server: FakeServer, storage: StorageLike, file: File, flag: "removed" | "hidden") {
    const fingerprint = await fingerprintFile(file);
    server.uploads.set("media-old", { mediaId: "media-old", uploadId: "u", size: file.size, fingerprint, parts: new Set([1]), status: "uploaded", [flag]: true });
    createSentFiles(storage).remember(file.size, fingerprint, "media-old");
  }

  it("is sent afresh when its guest removed it: they want it back", async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const file = video(MEBIBYTE);
    await remembered(server, storage, file, "removed");
    const { store, pick } = setUp({ server, storage });

    const [item] = pick([file]);
    await until(() => itemOf(store, item.id)?.status === "added");
    expect(itemOf(store, item.id)?.mediaId).not.toBe("media-old");
    expect(server.count("POST", /^\/api\/uploads$/)).toBe(1);
  });

  it("is never added again when the couple hid it", async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const file = video(MEBIBYTE);
    await remembered(server, storage, file, "hidden");
    const { store, pick } = setUp({ server, storage });

    const [item] = pick([file]);
    await until(() => itemOf(store, item.id)?.status === "failed");
    expect(itemOf(store, item.id)?.failure).toEqual({ reason: "This one can't be added to the album", hint: null, canRetry: false });
    expect(server.count("POST", /^\/api\/uploads$/)).toBe(0);
  });
});

describe("Cancel", () => {
  /** A file part-way: its first part sent, the rest held. */
  async function sending(setup: ReturnType<typeof setUp>) {
    let release: () => void = () => {};
    setup.server.holdPuts = new Promise((resolve) => {
      release = resolve;
    });
    const [item] = setup.pick([video(20 * MEBIBYTE)]);
    await until(() => setup.server.puts.length > 0);
    return { item, release };
  }

  it("ends the upload on the server, and the file leaves the card", async () => {
    const setup = setUp();
    const { item } = await sending(setup);

    setup.engine.cancel(item.id);
    expect(setup.store.getSnapshot().view).toEqual({ kind: "none" });
    await until(() => setup.store.get(item.id) === undefined);
    expect(setup.server.count("DELETE", /^\/api\/uploads\/media-1$/)).toBe(1);
    expect(setup.server.uploads.has("media-1")).toBe(false);
    expect(createPendingCancels(setup.storage).list()).toEqual([]);
    expect(createStartedFiles(setup.storage).hasUnfinished()).toBe(false);
  });

  it("removes the file when it had already arrived (409), so the guest's wish holds", async () => {
    const setup = setUp();
    const { item } = await sending(setup);
    setup.server.uploads.get("media-1")!.status = "uploaded";

    setup.engine.cancel(item.id);
    await until(() => setup.store.get(item.id) === undefined);
    expect(setup.server.uploads.get("media-1")?.removed).toBe(true);
  });

  it("waits until the phone is back online, uncounted, before it sends", async () => {
    const setup = setUp();
    const { item } = await sending(setup);
    setup.network.offline = true;

    setup.engine.cancel(item.id);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(setup.server.count("DELETE", /./)).toBe(0);
    setup.network.backOnline();
    await until(() => setup.store.get(item.id) === undefined);
    expect(setup.server.count("DELETE", /./)).toBe(1);
  });

  // A server that never answers: three tries, each retried three more times by the API client;
  // kept for the next visit. A 403 (the upload is no longer this browser's guest's): one try, and
  // dropped, as no later visit can do better.
  for (const [what, answer, deletes, kept] of [
    ["the server never answers", { status: 503, body: { error: "unavailable" } }, 3 * 4, ["media-1"]],
    ["the server refuses it (403 is not done)", { status: 403, body: { error: "forbidden" } }, 1, []],
  ] as const) {
    it(`tells the guest when ${what}, and Try again sends it again`, async () => {
      const setup = setUp();
      const { item } = await sending(setup);
      setup.server.answerDelete = () => answer;

      setup.engine.cancel(item.id);
      await until(() => setup.store.get(item.id)?.status === "failed");
      expect(setup.store.get(item.id)?.failure).toEqual({
        reason: "We couldn't remove this one yet",
        hint: null,
        canRetry: true,
        cancelFailed: true,
      });
      expect(setup.server.count("DELETE", /./)).toBe(deletes);
      expect(createPendingCancels(setup.storage).list().map((cancel) => cancel.mediaId)).toEqual(kept);

      setup.server.answerDelete = null;
      setup.engine.retry(item.id);
      await until(() => setup.store.get(item.id) === undefined);
      expect(createPendingCancels(setup.storage).list()).toEqual([]);
    });
  }

  it("sends a Cancel left from an earlier visit: keeps it while unanswered, drops it once done, refused (403) or a week old", async () => {
    const storage = memoryStorage();
    const pending = createPendingCancels(storage);
    pending.add("media-gone", null);
    pending.add("media-refused", null);
    pending.add("media-unanswered", "upload-9");
    pending.add("media-old", null, Date.now() - 8 * 24 * 60 * 60 * 1000);
    const server = new FakeServer();
    const answers: Record<string, Answer> = {
      "media-gone": { status: 404, body: { error: "not-found" } },
      "media-refused": { status: 403, body: { error: "forbidden" } },
      "media-unanswered": { status: 503, body: { error: "unavailable" } },
    };
    server.answerDelete = (mediaId) => answers[mediaId] ?? { status: 200 };
    const { engine } = setUp({ server, storage });

    await engine.replayPendingCancels();

    expect(createPendingCancels(storage).list().map((cancel) => cancel.mediaId)).toEqual(["media-unanswered"]);
    expect(server.count("DELETE", /media-gone/)).toBe(1);
    expect(server.count("DELETE", /media-refused/)).toBe(1);
    expect(server.count("DELETE", /media-old/)).toBe(0);
  });

  it("only stops a file picked again while it is being asked about: the copy in the album stays", async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const file = video(MEBIBYTE);
    const fingerprint = await fingerprintFile(file);
    server.uploads.set("media-sent", { mediaId: "media-sent", uploadId: "u", size: file.size, fingerprint, parts: new Set([1]), status: "uploaded" });
    createSentFiles(storage).remember(file.size, fingerprint, "media-sent");
    let release: () => void = () => {};
    server.completeGate = new Promise((resolve) => {
      release = resolve;
    });
    const { store, engine, pick } = setUp({ server, storage });

    const [item] = pick([file]);
    await until(() => server.count("POST", /\/complete$/) === 1);
    engine.cancel(item.id);
    expect(store.getSnapshot().view).toEqual({ kind: "none" });
    release();

    await until(() => store.get(item.id) === undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.count("DELETE", /./)).toBe(0);
    expect(server.count("POST", /\/remove$/)).toBe(0);
    expect(server.uploads.get("media-sent")?.removed).toBeUndefined();
  });

  /** A file sent whole, whose complete answer was lost (the complete and the API client's three tries), now being asked about, held. */
  async function lostAnswerBeingAskedAbout(setup: ReturnType<typeof setUp>) {
    setup.server.loseCompleteAnswers = 4;
    setup.server.holdCompletesFrom = 5;
    let release: () => void = () => {};
    setup.server.completeGate = new Promise((resolve) => {
      release = resolve;
    });
    const [item] = setup.pick([video(MEBIBYTE)]);
    await until(() => setup.server.completeCalls === 5);
    return { item, release };
  }

  it("cancels on the server a file of its own whose complete answer was lost, even while it is being asked about", async () => {
    const setup = setUp();
    const { item, release } = await lostAnswerBeingAskedAbout(setup);
    expect(setup.server.uploads.get("media-1")?.status).toBe("uploaded");

    setup.engine.cancel(item.id);
    release();

    // It had arrived: DELETE answers 409, so it is removed, and only then does the card go.
    await until(() => setup.store.get(item.id) === undefined);
    expect(setup.server.count("DELETE", /^\/api\/uploads\/media-1$/)).toBe(1);
    expect(setup.server.count("POST", /^\/api\/media\/media-1\/remove$/)).toBe(1);
    expect(setup.server.uploads.get("media-1")?.removed).toBe(true);
  });

  it("shows the outcome when that Cancel can't be finished, rather than letting the card vanish", async () => {
    const setup = setUp();
    const { item, release } = await lostAnswerBeingAskedAbout(setup);
    setup.server.answerRemove = () => ({ status: 503, body: { error: "unavailable" } });

    setup.engine.cancel(item.id);
    release();

    await until(() => setup.store.get(item.id)?.status === "failed");
    expect(setup.store.get(item.id)?.failure).toMatchObject({ reason: "We couldn't remove this one yet", cancelFailed: true });
    expect(setup.server.uploads.get("media-1")?.removed).toBeUndefined();
  });

  it("keeps the row of a Cancel that failed, even when the upload's start never answered", async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const file = video(MEBIBYTE);
    const fingerprint = await fingerprintFile(file);
    // An upload of this file left unfinished: asked about, it isn't finished, so it is started again.
    server.uploads.set("media-unfinished", { mediaId: "media-unfinished", uploadId: "u", size: file.size, fingerprint, parts: new Set(), status: "uploading" });
    createSentFiles(storage).remember(file.size, fingerprint, "media-unfinished");
    let releaseStart: () => void = () => {};
    server.startGate = new Promise((resolve) => {
      releaseStart = resolve;
    });
    server.answerDelete = () => ({ status: 503, body: { error: "unavailable" } });
    const { store, engine, pick } = setUp({ server, storage });

    const [item] = pick([file]);
    await until(() => server.count("POST", /^\/api\/uploads$/) === 1);
    engine.cancel(item.id);
    await until(() => store.get(item.id)?.status === "failed");
    server.answerStart = () => ({ status: 503, body: { error: "unavailable" } });
    releaseStart();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(store.get(item.id)).toMatchObject({ status: "failed", failure: { reason: "We couldn't remove this one yet", cancelFailed: true } });
  });

  it("takes a failed Cancel's row for good when dismissed while its start is still on its way", async () => {
    const server = new FakeServer();
    const storage = memoryStorage();
    const file = video(MEBIBYTE);
    const fingerprint = await fingerprintFile(file);
    server.uploads.set("media-unfinished", { mediaId: "media-unfinished", uploadId: "u", size: file.size, fingerprint, parts: new Set(), status: "uploading" });
    createSentFiles(storage).remember(file.size, fingerprint, "media-unfinished");
    let releaseStart: () => void = () => {};
    server.startGate = new Promise((resolve) => {
      releaseStart = resolve;
    });
    server.answerDelete = () => ({ status: 503, body: { error: "unavailable" } });
    const { store, engine, pick } = setUp({ server, storage });

    const [item] = pick([file]);
    await until(() => server.count("POST", /^\/api\/uploads$/) === 1);
    engine.cancel(item.id);
    await until(() => store.get(item.id)?.status === "failed");
    engine.dismiss(item.id);
    expect(store.get(item.id)).toBeUndefined();

    // The start answers after all: the Cancel goes again (it still can't be finished), but the row stays gone.
    releaseStart();
    await until(() => server.count("DELETE", /./) >= 2 * 3 * 4);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.get(item.id)).toBeUndefined();
    expect(store.getSnapshot().items).toEqual([]);
  });

  it("takes a file whose Cancel went unanswered off the card when dismissed, still sending it next visit", async () => {
    const setup = setUp();
    const { item } = await sending(setup);
    setup.server.answerDelete = () => ({ status: 503 });

    setup.engine.cancel(item.id);
    await until(() => setup.store.get(item.id)?.status === "failed");
    setup.engine.dismiss(item.id);
    expect(setup.store.get(item.id)).toBeUndefined();
    expect(createPendingCancels(setup.storage).list()).toHaveLength(1);
  });
});
