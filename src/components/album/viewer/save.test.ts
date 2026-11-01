import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadAnswer } from "../album-client";
import { fetchWhole, prepareSave, STALL_MILLISECONDS, waitForLink, type SaveDependencies } from "./save";

/*
 * Save to Photos' first tap (gate B 1c), and the link a download waits for. Fix round 1: a video
 * that won't fetch downloads instead, as a photo does (Ruling BO, Important #1); a fetch that sends
 * nothing for 30 s gives up the same way; progress is told at most every 250 ms; the wait for a
 * HEIC's JPEG stops the moment it is told to (Minor #1).
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const noProgress = () => {};
const ready = (url: string): DownloadAnswer => ({ status: "ready", url, filename: "NONA26-reception-7f3k2a9c.jpg" });

function dependencies(overrides: Partial<SaveDependencies>): SaveDependencies {
  return {
    downloadLink: async () => ready("https://storage.example/original.jpg?signed"),
    fetchWhole: async () => new Blob(["bytes"]),
    wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
}

describe("prepareSave", () => {
  it("downloads a video's phone version instead when its file won't fetch", async () => {
    const outcome = await prepareSave({
      mediaId: "video-1",
      source: { variant: "converted", url: "https://media.example/playable.mp4", extension: "mp4", type: "video/mp4" },
      filename: "NONA26-reception-video-1.mp4",
      signal: new AbortController().signal,
      onProgress: noProgress,
      dependencies: dependencies({ fetchWhole: async () => Promise.reject(new TypeError("Failed to fetch")) }),
    });
    expect(outcome).toEqual({ kind: "download", variant: "converted" });
  });

  it("downloads a photo's original instead when its file won't fetch, and a file it gets is ready to share", async () => {
    const photo = { variant: "original", extension: "jpg", type: "image/jpeg" } as const;
    const failed = await prepareSave({
      mediaId: "photo-1",
      source: photo,
      filename: "NONA26-reception-photo-1.jpg",
      signal: new AbortController().signal,
      onProgress: noProgress,
      dependencies: dependencies({ fetchWhole: async () => Promise.reject(new TypeError("Failed to fetch")) }),
    });
    expect(failed).toEqual({ kind: "download", variant: "original" });

    const fetched = await prepareSave({
      mediaId: "photo-1",
      source: photo,
      filename: "NONA26-reception-photo-1.jpg",
      signal: new AbortController().signal,
      onProgress: noProgress,
      dependencies: dependencies({}),
    });
    expect(fetched.kind).toBe("ready");
    if (fetched.kind === "ready") expect(fetched.file).toMatchObject({ name: "NONA26-reception-photo-1.jpg", type: "image/jpeg" });
  });

  it("waits for a HEIC's JPEG to be made, then fetches it", async () => {
    const answers: DownloadAnswer[] = [{ status: "preparing" }, { status: "preparing" }, ready("https://storage.example/jpeg.jpg?signed")];
    const fetched: string[] = [];
    const outcome = prepareSave({
      mediaId: "heic-1",
      source: { variant: "jpeg", extension: "jpg", type: "image/jpeg" },
      filename: "NONA26-reception-heic-1.jpg",
      signal: new AbortController().signal,
      onProgress: noProgress,
      dependencies: dependencies({
        downloadLink: async () => answers.shift() as DownloadAnswer,
        fetchWhole: async (url) => (fetched.push(url), new Blob(["jpeg"])),
      }),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await outcome).kind).toBe("ready");
    expect(fetched).toEqual(["https://storage.example/jpeg.jpg?signed"]);
  });

  it("starts nothing once the guest has moved on", async () => {
    const stopped = new AbortController();
    stopped.abort();
    const outcome = await prepareSave({
      mediaId: "video-1",
      source: { variant: "converted", url: "https://media.example/playable.mp4", extension: "mp4", type: "video/mp4" },
      filename: "NONA26-reception-video-1.mp4",
      signal: stopped.signal,
      onProgress: noProgress,
      dependencies: dependencies({ fetchWhole: async () => Promise.reject(new DOMException("aborted", "AbortError")) }),
    });
    expect(outcome).toEqual({ kind: "stopped" });
  });
});

describe("waitForLink", () => {
  it("asks every few seconds until the JPEG is made, and stops at once when told to", async () => {
    let asked = 0;
    const controller = new AbortController();
    const waiting = waitForLink("heic-1", "jpeg", {
      downloadLink: async () => (asked += 1, { status: "preparing" }),
      wait: (milliseconds, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        }),
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(9_000);
    const askedBeforeStop = asked;
    controller.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await waiting).toEqual({ status: "stopped" });
    expect(askedBeforeStop).toBeGreaterThanOrEqual(3);
    expect(asked).toBe(askedBeforeStop);
  });

  it("gives up after two minutes of being made", async () => {
    const waiting = waitForLink("heic-1", "jpeg", {
      downloadLink: async () => ({ status: "preparing" }),
      wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(await waiting).toEqual({ status: "unavailable" });
  });
});

/** A response whose body sends these chunks at once and then, unless `end`, nothing more. */
function streaming(chunks: Uint8Array[], options: { end: boolean; length?: number }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (options.end) controller.close();
    },
  });
  return new Response(body, { headers: options.length ? { "content-length": String(options.length) } : {} });
}

describe("fetchWhole", () => {
  it("gives up after 30 s with no bytes, so the save can download instead", async () => {
    const failing = fetchWhole("https://media.example/playable.mp4", {
      signal: new AbortController().signal,
      onProgress: noProgress,
      fetchImplementation: async (_url, init) => {
        const response = streaming([new Uint8Array(1024)], { end: false, length: 4096 });
        init?.signal?.addEventListener("abort", () => response.body?.cancel().catch(() => {}));
        return response;
      },
    });
    const settled = failing.then(
      () => "fetched",
      (error: unknown) => (error as Error).name,
    );
    await vi.advanceTimersByTimeAsync(STALL_MILLISECONDS + 1_000);
    expect(await settled).toBe("StallError");
  });

  it("tells its progress at most every 250 ms, and once more at the end", async () => {
    const told: (number | null)[] = [];
    const chunks = Array.from({ length: 200 }, () => new Uint8Array(512));
    const blob = await fetchWhole("https://media.example/playable.mp4", {
      signal: new AbortController().signal,
      onProgress: (fraction) => told.push(fraction),
      fetchImplementation: async () => streaming(chunks, { end: true, length: 200 * 512 }),
    });
    expect(blob.size).toBe(200 * 512);
    expect(told.length).toBeLessThanOrEqual(3);
    expect(told.at(-1)).toBe(1);
  });

  it("is a plain GET: no headers of its own, no cache mode", async () => {
    let seen: RequestInit | undefined;
    await fetchWhole("https://media.example/playable.mp4", {
      signal: new AbortController().signal,
      onProgress: noProgress,
      fetchImplementation: async (_url, init) => ((seen = init), streaming([new Uint8Array(1)], { end: true })),
    });
    expect(Object.keys(seen ?? {}).sort()).toEqual(["signal"]);
  });
});
