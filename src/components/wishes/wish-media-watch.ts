import { createItemWatch, pageVisibility, type ItemWatch, type ItemWatchOptions } from "@/components/album/item-watch";
import { createApiClient, type ApiClient } from "@/components/album/uploader/api";
import type { WishMediaState } from "@/lib/data/types";

/*
 * The sender's "Getting your wish ready…" check (Ruling BU): Task 15's item-watch scheduler, asking
 * GET /api/wishes/media?ids= for every pending card of the page in one request a round (every 5 s
 * for 3 minutes, then every 30 s, paused while the page is hidden, rounds never overlapping). The
 * read answers only the browser's own recordings; one it leaves out (hidden, deleted) is gone.
 */

/** A recording's news: how far it has got. */
export type WishMedia = { id: string; state: WishMediaState };

const TIMEOUT_MILLISECONDS = 10_000;

/** The batched read, through the upload client's API client: a 429 is waited out, never shown. Throws when it couldn't ask. */
export function wishMediaFetcher(api: ApiClient): ItemWatchOptions<WishMedia>["fetchItems"] {
  return async (mediaIds) => {
    const path = `/api/wishes/media?ids=${mediaIds.map(encodeURIComponent).join(",")}`;
    const { status, body } = await api.request(path, { method: "GET", timeoutMs: TIMEOUT_MILLISECONDS });
    if (status !== 200) throw new Error(`The recordings answered ${status}`);
    const items = (body as { items?: unknown } | null)?.items;
    return Array.isArray(items) ? (items as WishMedia[]) : [];
  };
}

let pageWatch: ItemWatch<WishMedia> | null = null;

/** The page's one shared check of its pending wishes' recordings. */
export function wishMediaWatch(): ItemWatch<WishMedia> {
  pageWatch ??= createItemWatch<WishMedia>({ fetchItems: wishMediaFetcher(createApiClient()), visibility: pageVisibility() });
  return pageWatch;
}
