import { filterQuery, type AlbumFilter, type AlbumItem, type AlbumPage, type AlbumStats } from "@/lib/media/album-item";
import { createApiClient, type ApiClient } from "./uploader/api";

/*
 * The album page's calls to the site's own API (Task 15), each under a 10 s timeout. A 429 is waited
 * out by its Retry-After and asked again, never shown (the uploader's client); a dropped connection
 * is tried again a few times, then reported as a failure for the page to say so calmly.
 */

const TIMEOUT_MILLISECONDS = 10_000;

let client: ApiClient | null = null;
function api(): ApiClient {
  client ??= createApiClient();
  return client;
}

/** Thrown when the album couldn't be reached after its tries. */
export class AlbumUnavailable extends Error {
  override name = "AlbumUnavailable";
}

async function getJson(path: string, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
  try {
    return await api().request(path, { method: "GET", timeoutMs: TIMEOUT_MILLISECONDS, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new AlbumUnavailable(error instanceof Error ? error.message : "The album couldn't be reached");
  }
}

function withQuery(path: string, query: URLSearchParams): string {
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

/** A page of the album for the filter, from `cursor` (none for the first). */
export async function fetchPage(filter: AlbumFilter, cursor: string | null, signal?: AbortSignal): Promise<AlbumPage> {
  const query = filterQuery(filter);
  if (cursor) query.set("cursor", cursor);
  const { status, body } = await getJson(withQuery("/api/album", query), signal);
  if (status !== 200) throw new AlbumUnavailable(`The album answered ${status}`);
  return body as AlbumPage;
}

/** The first page again, with the album's counts: the pill past 60 new moments reads both afresh. */
export async function fetchFirstPageWithStats(filter: AlbumFilter, signal?: AbortSignal): Promise<AlbumPage & { stats: AlbumStats }> {
  const query = filterQuery(filter);
  query.set("stats", "1");
  const { status, body } = await getJson(withQuery("/api/album", query), signal);
  if (status !== 200) throw new AlbumUnavailable(`The album answered ${status}`);
  return body as AlbumPage & { stats: AlbumStats };
}

export type NewerAnswer = { items: AlbumItem[]; complete: boolean; newestCursor: string | null };

/** The moments listed since `since`, for the pill. */
export async function fetchNewer(filter: AlbumFilter, since: string, signal?: AbortSignal): Promise<NewerAnswer> {
  const query = filterQuery(filter);
  query.set("newer", since);
  const { status, body } = await getJson(withQuery("/api/album", query), signal);
  if (status !== 200) throw new AlbumUnavailable(`The album answered ${status}`);
  return body as NewerAnswer;
}

export type NewCountAnswer = { count: number; newest: { id: string; thumb: string | null; color: string | null }[] };

/** How many moments were listed since `since`; null when the album couldn't say. */
export async function fetchNewCount(filter: AlbumFilter, since: string, signal?: AbortSignal): Promise<NewCountAnswer | null> {
  const query = filterQuery(filter);
  query.set("since", since);
  const { status, body } = await getJson(withQuery("/api/album/new", query), signal);
  return status === 200 ? (body as NewCountAnswer) : null;
}

/** One moment as the album has it now; null once it isn't there (hidden, removed, or never this browser's to see). */
export async function fetchItem(mediaId: string, signal?: AbortSignal): Promise<AlbumItem | null> {
  const { status, body } = await getJson(`/api/media/${encodeURIComponent(mediaId)}`, signal);
  if (status === 404) return null;
  if (status !== 200) throw new AlbumUnavailable(`The moment answered ${status}`);
  return (body as { item: AlbumItem }).item;
}

/** Several moments as the album has them now, in one request (a missing one is gone). Throws when it couldn't ask. */
export async function fetchItems(mediaIds: string[], signal?: AbortSignal): Promise<AlbumItem[]> {
  const { status, body } = await getJson(`/api/media?ids=${mediaIds.map(encodeURIComponent).join(",")}`, signal);
  if (status !== 200) throw new AlbumUnavailable(`The moments answered ${status}`);
  return (body as { items: AlbumItem[] }).items;
}

let guestCall: Promise<boolean> | null = null;

/**
 * Makes sure the browser has a guest of its own (POST /api/guest, once a page), for what the site
 * keys to one: asking for a video's phone version. A browser that has one keeps it.
 */
export function ensureGuest(): Promise<boolean> {
  guestCall ??= api()
    .request("/api/guest", { method: "POST", body: {}, timeoutMs: TIMEOUT_MILLISECONDS })
    .then((answer) => answer.status === 200)
    .catch(() => false)
    .then((made) => {
      if (!made) guestCall = null;
      return made;
    });
  return guestCall;
}

export type PlayableAnswer = { status: "ready"; url: string } | { status: "preparing" } | { status: "failed"; reason: string } | { status: "gone" };

/** Asks for a video's phone version (its conversion on demand, the first time); a browser without a guest gets one first. */
export async function askPlayable(mediaId: string, signal?: AbortSignal): Promise<PlayableAnswer | null> {
  const path = `/api/media/${encodeURIComponent(mediaId)}/playable`;
  const ask = () => api().request(path, { method: "POST", timeoutMs: TIMEOUT_MILLISECONDS, signal });
  try {
    let answer = await ask();
    if (answer.status === 403 && (await ensureGuest())) answer = await ask();
    if (answer.status === 404) return { status: "gone" };
    return answer.status === 200 ? (answer.body as PlayableAnswer) : null;
  } catch {
    return null;
  }
}

export type DownloadAnswer = { status: "ready"; url: string; filename: string } | { status: "preparing" } | { status: "gone" } | { status: "failed" };

/** A download's link, as JSON: ready, being made (a HEIC's JPEG), gone, or not reachable. */
export async function downloadLink(mediaId: string, variant: string, signal?: AbortSignal): Promise<DownloadAnswer> {
  try {
    const answer = await api().request(`/api/media/${encodeURIComponent(mediaId)}/download?variant=${variant}`, {
      method: "GET",
      timeoutMs: TIMEOUT_MILLISECONDS,
      accept: "application/json",
      signal,
    });
    if (answer.status === 200 || answer.status === 202) return answer.body as DownloadAnswer;
    if (answer.status === 404 || answer.status === 409) return { status: "gone" };
    return { status: "failed" };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "failed" };
  }
}

/** "Remove my upload": removed, refused (not this browser's, or already gone), or not reachable. */
export async function removeMoment(mediaId: string): Promise<"removed" | "refused" | "failed"> {
  try {
    const answer = await api().request(`/api/media/${encodeURIComponent(mediaId)}/remove`, { method: "POST", timeoutMs: 20_000 });
    if (answer.status === 200) return "removed";
    return answer.status === 403 || answer.status === 404 ? "refused" : "failed";
  } catch {
    return "failed";
  }
}
