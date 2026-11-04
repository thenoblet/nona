import { createApiClient, type ApiClient } from "@/components/album/uploader/api";
import { createPartPut, type PartPut } from "@/components/album/uploader/part-put";
import type { EditorPhoto } from "@/lib/site-images/admin";

/*
 * The admin's upload of one site photo (Task 19): the same presigned multipart upload as a guest's,
 * straight to R2 in 8 MiB parts with no custom headers, through the admin's own routes
 * (/admin/photos/site/uploads, under Cloudflare Access). One file at a time and at most 50 MB
 * (seven parts), so a plain loop over the guests' API client (timeouts, retries, 429s waited out)
 * and part PUT (progress, stalls dropped and sent again) rather than the album's Uppy engine,
 * whose resume, fingerprints and guest records a laptop upload of one photo doesn't need.
 * Then it waits for the worker to make the photo's sizes.
 */

const BASE = "/admin/photos/site/uploads";
/** Parts in flight at once. */
const PARTS_AT_ONCE = 3;
/** Each part tried this many times when its PUT fails or stalls. */
const PART_ATTEMPTS = 4;
const API_TIMEOUT_MILLISECONDS = 10_000;
/** How long the worker gets to make the sizes before the editor stops waiting (a photo takes seconds). */
const READY_WAIT_MILLISECONDS = 3 * 60_000;
const READY_POLL_MILLISECONDS = 1_500;

export class SiteUploadError extends Error {
  override name = "SiteUploadError";
}

type Session = { mediaId: string; partSize: number; partCount: number };

/** The content type to declare: the file's own, or HEIC by its name when the browser doesn't know it. */
export function declaredType(file: Pick<File, "type" | "name">): string {
  if (file.type) return file.type;
  return /\.(heic|heif)$/i.test(file.name) ? "image/heic" : "application/octet-stream";
}

function messageOf(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : fallback;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * Sends the file and completes its upload; `onProgress` gets 0–1 as its bytes go. Returns the new
 * site photo's media id. Throws a SiteUploadError with words the couple can read.
 */
export async function uploadSitePhoto(
  file: File,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal; api?: ApiClient; partPut?: PartPut } = {},
): Promise<string> {
  const api = options.api ?? createApiClient();
  const partPut = options.partPut ?? createPartPut();
  const { signal } = options;
  const request = (path: string, body?: unknown) =>
    api.request(path, { method: "POST", body, timeoutMs: API_TIMEOUT_MILLISECONDS, signal });

  const started = await request(BASE, { filename: file.name, size: file.size, contentType: declaredType(file) });
  if (started.status !== 200) throw new SiteUploadError(messageOf(started.body, "That photo couldn't be sent. Try again."));
  const session = started.body as Session;

  const partNumbers = Array.from({ length: session.partCount }, (_part, index) => index + 1);
  const presigned = await request(`${BASE}/${session.mediaId}/parts`, { partNumbers });
  if (presigned.status !== 200) throw new SiteUploadError("The upload couldn't start. Try again.");
  const urls = new Map((presigned.body as { urls: { partNumber: number; url: string }[] }).urls.map((part) => [part.partNumber, part.url]));

  const sent = new Map<number, number>();
  const report = () => options.onProgress?.([...sent.values()].reduce((total, bytes) => total + bytes, 0) / file.size);
  const parts: { partNumber: number; etag: string }[] = [];
  const queue = [...partNumbers];
  const sendPart = async (partNumber: number) => {
    const from = (partNumber - 1) * session.partSize;
    const body = file.slice(from, Math.min(file.size, from + session.partSize));
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { ETag } = await partPut({
          signature: { url: urls.get(partNumber) ?? "", method: "PUT" },
          body,
          size: body.size,
          signal,
          onProgress: (event) => {
            sent.set(partNumber, event.loaded);
            report();
          },
        });
        sent.set(partNumber, body.size);
        report();
        parts.push({ partNumber, etag: ETag });
        return;
      } catch (error) {
        if (signal?.aborted || attempt >= PART_ATTEMPTS) throw error;
        sent.set(partNumber, 0);
        await delay(1_000 * attempt, signal);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PARTS_AT_ONCE, queue.length) }, async () => {
      for (let partNumber = queue.shift(); partNumber !== undefined; partNumber = queue.shift()) await sendPart(partNumber);
    }),
  ).catch((error) => {
    if (signal?.aborted) throw error;
    throw new SiteUploadError("The connection dropped while the photo was sending. Try again.");
  });

  parts.sort((first, second) => first.partNumber - second.partNumber);
  const completed = await request(`${BASE}/${session.mediaId}/complete`, { parts });
  if (completed.status !== 200) throw new SiteUploadError(messageOf(completed.body, "The photo didn't arrive whole. Try again."));
  return session.mediaId;
}

/** Waits until the worker has made the photo's sizes, and returns its viewing size for the editor. */
export async function waitUntilReady(
  mediaId: string,
  options: { signal?: AbortSignal; api?: ApiClient } = {},
): Promise<EditorPhoto> {
  const api = options.api ?? createApiClient();
  const deadline = Date.now() + READY_WAIT_MILLISECONDS;
  for (;;) {
    const answer = await api.request(`${BASE}/${mediaId}`, { method: "GET", timeoutMs: API_TIMEOUT_MILLISECONDS, signal: options.signal });
    const body = answer.body as { status?: string; photo?: EditorPhoto; reason?: string } | null;
    if (answer.status === 200 && body?.status === "ready" && body.photo) return body.photo;
    if (answer.status === 200 && body?.status === "failed") {
      throw new SiteUploadError(
        body.reason === "unsupported-type" ? "That file isn't a photo the site can show. Try another." : "That photo couldn't be read. Try another.",
      );
    }
    if (answer.status !== 200) throw new SiteUploadError("The photo arrived, but couldn't be checked. Reload and try again.");
    if (Date.now() > deadline) throw new SiteUploadError("The photo is taking a long time to get ready. Reload in a minute and try again.");
    await delay(READY_POLL_MILLISECONDS, options.signal);
  }
}
