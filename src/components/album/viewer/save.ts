import type { DownloadAnswer } from "../album-client";
import type { DownloadVariant, Savable } from "./downloads";

/*
 * Save to Photos (gate B 1c): a phone opens its share menu only straight after a tap, and a video
 * takes longer than that to fetch, so it takes two taps. The first fetches the file (from its
 * presigned link, or the public bucket for a video's phone version), with its progress; the second
 * hands it to the share menu, where the guest picks Photos or Gallery. A file that won't fetch (its
 * bucket's CORS, a stalled connection) downloads the plain way instead, photo or video (Ruling BO).
 */

/** A fetch that has sent nothing for this long is given up, and the save downloads instead. */
export const STALL_MILLISECONDS = 30_000;
/**
 * The most Save to Photos reads into the page: the file is held whole in memory before the share
 * menu takes it, and a long video's version (up to about 2 GB) could crash a phone's tab, and an
 * upload running in it. A bigger file downloads the plain way instead, never read here.
 */
export const SAVE_AT_MOST_BYTES = 200 * 1024 * 1024;
/** Progress is told at most this often: a 100 MB video arrives in thousands of chunks. */
const PROGRESS_MILLISECONDS = 250;
/** A HEIC's JPEG, while it is made: asked after every few seconds, for at most two minutes. */
export const LINK_CHECK_MILLISECONDS = 3_000;
const LINK_CHECKS = 40;

/** Waits, or stops waiting as soon as `signal` is aborted. */
export function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A fetch given up for sending nothing for STALL_MILLISECONDS. */
export class StallError extends Error {
  override name = "StallError";
}

/** A file past what Save to Photos reads into the page (SAVE_AT_MOST_BYTES), given up unread. */
export class TooBigToSaveError extends Error {
  override name = "TooBigToSaveError";
}

type FetchImplementation = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetches the file at `url` whole, saying how far it has got (a fraction, once its size is known).
 * A plain GET (no Range, no headers of its own, no cache mode), so the buckets' CORS for a simple GET
 * covers it. It gives up with a StallError after STALL_MILLISECONDS with no bytes, and with a
 * TooBigToSaveError for a file past `maxBytes` (SAVE_AT_MOST_BYTES): at once when its length says
 * so, or as soon as more than that has arrived.
 */
export async function fetchWhole(
  url: string,
  options: {
    signal: AbortSignal;
    onProgress: (fraction: number | null, totalBytes: number | null) => void;
    fetchImplementation?: FetchImplementation;
    maxBytes?: number;
  },
): Promise<Blob> {
  const maxBytes = options.maxBytes ?? SAVE_AT_MOST_BYTES;
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal.reason);
  if (options.signal.aborted) onAbort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const stillHearing = () => {
    if (stallTimer !== null) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort(new StallError(`Nothing arrived for ${STALL_MILLISECONDS} ms`));
    }, STALL_MILLISECONDS);
  };
  try {
    stillHearing();
    const fetchFile = options.fetchImplementation ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const response = await fetchFile(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`The file answered ${response.status}`);
    const total = Number(response.headers.get("content-length")) || null;
    if (total !== null && total > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new TooBigToSaveError(`The file is ${total} bytes, more than ${maxBytes}`);
    }
    options.onProgress(total ? 0 : null, total);
    if (!response.body) return await response.blob();
    const reader = response.body.getReader();
    controller.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    let toldAt = Date.now();
    for (;;) {
      const { done, value } = await reader.read();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (done) break;
      stillHearing();
      chunks.push(value as Uint8Array<ArrayBuffer>);
      received += value.length;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new TooBigToSaveError(`More than ${maxBytes} bytes arrived`);
      }
      if (Date.now() - toldAt >= PROGRESS_MILLISECONDS) {
        toldAt = Date.now();
        options.onProgress(total ? Math.min(1, received / total) : null, total);
      }
    }
    options.onProgress(1, total ?? received);
    return new Blob(chunks, { type: response.headers.get("content-type") ?? undefined });
  } catch (error) {
    if (stalled) throw new StallError(`Nothing arrived for ${STALL_MILLISECONDS} ms`);
    throw error;
  } finally {
    if (stallTimer !== null) clearTimeout(stallTimer);
    options.signal.removeEventListener("abort", onAbort);
  }
}

export type LinkWait =
  | { status: "ready"; url: string }
  /** Not there (gone, or never made in two minutes), or the site couldn't be reached. */
  | { status: "unavailable" }
  | { status: "stopped" };

/**
 * A download's link, waiting while a HEIC's JPEG is made (asked after every few seconds, for at most
 * two minutes). Stops at once when `signal` is aborted (the viewer closed, or moved on: fix round 1,
 * Minor #1).
 */
export async function waitForLink(
  mediaId: string,
  variant: DownloadVariant,
  options: {
    downloadLink: (mediaId: string, variant: string, signal?: AbortSignal) => Promise<DownloadAnswer>;
    wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    signal: AbortSignal;
  },
): Promise<LinkWait> {
  for (let check = 0; check < LINK_CHECKS; check += 1) {
    if (options.signal.aborted) return { status: "stopped" };
    const answer = await options.downloadLink(mediaId, variant, options.signal).catch(() => ({ status: "failed" }) as const);
    if (options.signal.aborted) return { status: "stopped" };
    if (answer.status === "ready") return { status: "ready", url: answer.url };
    if (answer.status !== "preparing") return { status: "unavailable" };
    await options.wait(LINK_CHECK_MILLISECONDS, options.signal);
  }
  return options.signal.aborted ? { status: "stopped" } : { status: "unavailable" };
}

export type SaveDependencies = {
  downloadLink: (mediaId: string, variant: string, signal?: AbortSignal) => Promise<DownloadAnswer>;
  fetchWhole: typeof fetchWhole;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export type PreparedSave =
  /** The file, for the share menu. */
  | { kind: "ready"; file: File }
  /** It won't fetch: download it the plain way instead (Ruling BO). */
  | { kind: "download"; variant: DownloadVariant }
  /** The guest moved on, or closed the viewer. */
  | { kind: "stopped" };

/**
 * Save to Photos' first tap: the file, fetched whole, or, when it won't fetch (no link, the bucket's
 * CORS, a stall, or a file too big to hold in the page), the download to start instead. Photos,
 * HEICs' JPEGs and videos alike.
 */
export async function prepareSave(options: {
  mediaId: string;
  source: Savable;
  filename: string;
  signal: AbortSignal;
  onProgress: (fraction: number | null, totalBytes: number | null) => void;
  dependencies: SaveDependencies;
}): Promise<PreparedSave> {
  const { mediaId, source, signal, dependencies } = options;
  const fallback: PreparedSave = { kind: "download", variant: source.variant };
  let url = source.url;
  if (!url) {
    const link = await waitForLink(mediaId, source.variant, { downloadLink: dependencies.downloadLink, wait: dependencies.wait, signal });
    if (link.status === "stopped") return { kind: "stopped" };
    if (link.status !== "ready") return fallback;
    url = link.url;
  }
  try {
    const blob = await dependencies.fetchWhole(url, { signal, onProgress: options.onProgress });
    if (signal.aborted) return { kind: "stopped" };
    return { kind: "ready", file: new File([blob], options.filename, { type: source.type }) };
  } catch {
    return signal.aborted ? { kind: "stopped" } : fallback;
  }
}

export type ShareOutcome = "shared" | "dismissed" | "unsupported";

/** Hands the file to the phone's share menu: shared, dismissed by the guest, or not possible here. */
export async function shareFile(file: File): Promise<ShareOutcome> {
  try {
    if (!navigator.canShare?.({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file] });
    return "shared";
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError" ? "dismissed" : "unsupported";
  }
}

/** Saves the file the old way, as a download from the page itself (where sharing a file isn't possible). */
export function downloadFile(file: File): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
