import type { AlbumItem } from "@/lib/media/album-item";
import { fetchItems } from "./album-client";

/*
 * One shared check of the moments a page is waiting on (fix round 1, Important #2): the album's
 * tiles of the guest's own moments being made ready, and the uploader's cards waiting for the
 * server's thumbnail. Every watched moment goes in one request a tick (GET /api/media?ids=, one
 * token from the guest's `item` bucket however many it names), and each round starts only once
 * the last has finished, ITEM_WATCH_MILLISECONDS after it: rounds never overlap or pile up, so an
 * honest guest never runs into the limit. Past 50 watched moments, they take turns.
 */

/** The wait between one round's end and the next round's start. */
export const ITEM_WATCH_MILLISECONDS = 5_000;
/** The most moments one round asks after (GET /api/media's own limit). */
const MAX_IDS_PER_ROUND = 50;

/** Hears a moment's news each round: the moment as the album has it now, or null once it is gone. */
export type ItemListener = (item: AlbumItem | null) => void;

export type ItemWatch = {
  /** Starts asking after the moment; returns what stops it. */
  watch(mediaId: string, onChange: ItemListener): () => void;
};

export type ItemWatchOptions = {
  /** Every named moment the album still has; a missing one is gone. Throws when it couldn't ask. */
  fetchItems: (mediaIds: string[]) => Promise<AlbumItem[]>;
  maxIds?: number;
  intervalMilliseconds?: number;
  /** Whether the page is on screen: a round while it isn't asks nothing, and the next comes as usual. */
  isVisible?: () => boolean;
};

export function createItemWatch(options: ItemWatchOptions): ItemWatch {
  const maxIds = options.maxIds ?? MAX_IDS_PER_ROUND;
  const intervalMilliseconds = options.intervalMilliseconds ?? ITEM_WATCH_MILLISECONDS;
  /** Each watched moment's listeners, the longest-unasked first. */
  const listeners = new Map<string, Set<ItemListener>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  function scheduleNext(): void {
    if (timer !== null || running || listeners.size === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void round();
    }, intervalMilliseconds);
  }

  async function round(): Promise<void> {
    if (options.isVisible && !options.isVisible()) {
      scheduleNext();
      return;
    }
    running = true;
    const asked = [...listeners.keys()].slice(0, maxIds);
    // The ones asked after go to the back of the line, so past maxIds every moment takes its turn.
    for (const mediaId of asked) {
      const waiting = listeners.get(mediaId);
      if (!waiting) continue;
      listeners.delete(mediaId);
      listeners.set(mediaId, waiting);
    }
    try {
      const items = new Map((await options.fetchItems(asked)).map((item) => [item.id, item]));
      for (const mediaId of asked) {
        for (const listener of [...(listeners.get(mediaId) ?? [])]) listener(items.get(mediaId) ?? null);
      }
    } catch {
      // Not answered (no signal for a moment): asked again next round.
    } finally {
      running = false;
      scheduleNext();
    }
  }

  return {
    watch(mediaId, onChange) {
      const forMoment = listeners.get(mediaId) ?? new Set<ItemListener>();
      forMoment.add(onChange);
      listeners.set(mediaId, forMoment);
      scheduleNext();
      return () => {
        const current = listeners.get(mediaId);
        current?.delete(onChange);
        if (current?.size === 0) listeners.delete(mediaId);
        if (listeners.size === 0 && timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };
    },
  };
}

let pageWatch: ItemWatch | null = null;

/** The page's one shared check, asking GET /api/media?ids=. */
export function itemWatch(): ItemWatch {
  pageWatch ??= createItemWatch({ fetchItems: (mediaIds) => fetchItems(mediaIds), isVisible: () => document.visibilityState === "visible" });
  return pageWatch;
}
