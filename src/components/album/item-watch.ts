import type { AlbumItem } from "@/lib/media/album-item";
import { fetchItems } from "./album-client";

/*
 * One shared check of the moments a page is waiting on (fix round 1, Important #2): the album's
 * tiles of the guest's own moments being made ready, and the uploader's cards waiting for the
 * server's thumbnail. Every moment due goes in one request a round (GET /api/media?ids=, one token
 * from the guest's `item` bucket however many it names), and each round starts only once the last
 * has finished, at least ITEM_WATCH_MILLISECONDS after it: rounds never overlap or pile up, so an
 * honest guest never runs into the limit. Past 50 moments due, they take turns.
 *
 * Ruling BQ: a moment is asked after every 5 s for its first 3 minutes, then every 30 s for as long
 * as it is watched (a worker backlog on the night can hold a photo longer; the guest shouldn't have
 * to reload to see it arrive). The checks pause while the page is hidden and start again as soon as
 * it is visible.
 */

/** A young moment's pace, and the least wait between one round's end and the next round's start. */
export const ITEM_WATCH_MILLISECONDS = 5_000;
/** How long a moment is asked after at that pace before it slows down. */
export const SLOW_AFTER_MILLISECONDS = 3 * 60_000;
/** The slower pace, for a moment watched for longer. */
export const SLOW_WATCH_MILLISECONDS = 30_000;
/** The most moments one round asks after (GET /api/media's own limit). */
const MAX_IDS_PER_ROUND = 50;

/** Hears a moment's news each time it is asked after: the moment as the album has it now, or null once it is gone. */
export type ItemListener = (item: AlbumItem | null) => void;

export type ItemWatch = {
  /** Starts asking after the moment; returns what stops it. */
  watch(mediaId: string, onChange: ItemListener): () => void;
};

/** Whether the page is on screen, and word when that changes (a browser's visibilitychange). */
export type Visibility = { isVisible: () => boolean; onChange: (listener: () => void) => () => void };

export type ItemWatchOptions = {
  /** Every named moment the album still has; a missing one is gone. Throws when it couldn't ask. */
  fetchItems: (mediaIds: string[]) => Promise<AlbumItem[]>;
  maxIds?: number;
  /** The page's visibility; without it, the page counts as always on screen. */
  visibility?: Visibility;
};

/** A watched moment: who hears its news, when it was first watched, and when it was last asked after. */
type Watched = { listeners: Set<ItemListener>; since: number; askedAt: number | null };

/** When the moment is next due: 5 s after it was last asked (or first watched), 30 s once that was 3 minutes in. */
function dueAt(entry: Watched): number {
  const from = entry.askedAt ?? entry.since;
  return from + (from - entry.since < SLOW_AFTER_MILLISECONDS ? ITEM_WATCH_MILLISECONDS : SLOW_WATCH_MILLISECONDS);
}

export function createItemWatch(options: ItemWatchOptions): ItemWatch {
  const maxIds = options.maxIds ?? MAX_IDS_PER_ROUND;
  const visible = () => options.visibility?.isVisible() ?? true;
  const watched = new Map<string, Watched>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When the timer set is to start the next round. */
  let timerAt = 0;
  let running = false;
  /** When the last round finished: the next starts at least ITEM_WATCH_MILLISECONDS after. */
  let lastFinishedAt: number | null = null;

  function clearTimer(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  /** Sets the next round for the soonest moment due; a moment watched since moves it sooner, never later. */
  function scheduleNext(): void {
    if (running || watched.size === 0 || !visible()) return;
    const earliest = Math.min(...[...watched.values()].map(dueAt));
    const startAt = Math.max(earliest, lastFinishedAt === null ? earliest : lastFinishedAt + ITEM_WATCH_MILLISECONDS);
    if (timer !== null && timerAt <= startAt) return;
    clearTimer();
    timerAt = startAt;
    timer = setTimeout(() => {
      timer = null;
      void round();
    }, Math.max(0, startAt - Date.now()));
  }

  async function round(): Promise<void> {
    if (!visible()) return;
    const now = Date.now();
    // Every moment due before the next round could start rides in this one: a slow moment beside a
    // young one is asked in the young one's round instead of a round of its own.
    const due = [...watched.entries()]
      .filter(([, entry]) => dueAt(entry) < now + ITEM_WATCH_MILLISECONDS)
      .sort(([, first], [, second]) => dueAt(first) - dueAt(second))
      .slice(0, maxIds);
    if (due.length === 0) {
      scheduleNext();
      return;
    }
    running = true;
    for (const [, entry] of due) entry.askedAt = now;
    const asked = due.map(([mediaId]) => mediaId);
    try {
      const items = new Map((await options.fetchItems(asked)).map((item) => [item.id, item]));
      for (const mediaId of asked) {
        for (const listener of [...(watched.get(mediaId)?.listeners ?? [])]) listener(items.get(mediaId) ?? null);
      }
    } catch {
      // Not answered (no signal for a moment): asked again when next due.
    } finally {
      running = false;
      lastFinishedAt = Date.now();
      scheduleNext();
    }
  }

  // Hidden, nothing is asked; visible again, the moments overdue are asked at once (still never
  // sooner than ITEM_WATCH_MILLISECONDS after the last round).
  options.visibility?.onChange(() => {
    if (visible()) scheduleNext();
    else clearTimer();
  });

  return {
    watch(mediaId, onChange) {
      const entry = watched.get(mediaId) ?? { listeners: new Set<ItemListener>(), since: Date.now(), askedAt: null };
      entry.listeners.add(onChange);
      watched.set(mediaId, entry);
      scheduleNext();
      return () => {
        const current = watched.get(mediaId);
        current?.listeners.delete(onChange);
        if (current?.listeners.size === 0) watched.delete(mediaId);
        if (watched.size === 0) clearTimer();
      };
    },
  };
}

let pageWatch: ItemWatch | null = null;

/** The page's one shared check, asking GET /api/media?ids=, paused while the page is hidden. */
export function itemWatch(): ItemWatch {
  pageWatch ??= createItemWatch({
    fetchItems: (mediaIds) => fetchItems(mediaIds),
    visibility: {
      isVisible: () => document.visibilityState === "visible",
      onChange: (listener) => {
        document.addEventListener("visibilitychange", listener);
        return () => document.removeEventListener("visibilitychange", listener);
      },
    },
  });
  return pageWatch;
}
