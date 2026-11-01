import type { AlbumItem } from "@/lib/media/album-item";
import type { PlayableAnswer } from "../album-client";

/*
 * A video this phone can't play yet (gate B 1a, the controller's order): the viewer asks for its
 * phone version (the conversion, on demand) unless a copy this phone plays is on its way, and asks
 * after the moment every 10 s until a version it plays is there. One loop at a time, each check
 * after the last; it stops when told to (the moment changed, or the viewer closed), and once the
 * moment has gone, saying so once (fix round 1, Minor #2).
 */

export const PREPARING_CHECK_MILLISECONDS = 10_000;
/** How long a video waits for a copy on its way before asking for a conversion instead. */
export const COPY_WAIT_MILLISECONDS = 60_000;

export async function followPreparation(options: {
  mediaId: string;
  /** Ask for the conversion at once (no copy this phone plays is coming). */
  askNow: boolean;
  fetchItem: (mediaId: string, signal?: AbortSignal) => Promise<AlbumItem | null>;
  askPlayable: (mediaId: string, signal?: AbortSignal) => Promise<PlayableAnswer | null>;
  /** The moment as the album has it now. */
  onItem: (item: AlbumItem) => void;
  /** What the playable route said (its conversion made, or failed for good). */
  onAnswer: (answer: PlayableAnswer) => void;
  /** The moment has gone (hidden, removed): the loop has stopped. */
  onGone: () => void;
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { mediaId, signal } = options;
  const startedAt = Date.now();
  let asked = false;
  const ask = async () => {
    asked = true;
    const answer = await options.askPlayable(mediaId, signal);
    if (signal.aborted || !answer) return;
    if (answer.status === "gone") {
      options.onGone();
      return "gone" as const;
    }
    options.onAnswer(answer);
  };
  if (options.askNow && (await ask()) === "gone") return;
  while (!signal.aborted) {
    await options.wait(PREPARING_CHECK_MILLISECONDS, signal);
    if (signal.aborted) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") continue;
    const fresh = await options.fetchItem(mediaId, signal).catch(() => undefined);
    if (signal.aborted) return;
    if (fresh === null) {
      options.onGone();
      return;
    }
    if (fresh) options.onItem(fresh);
    // A copy that was on its way and hasn't come: the conversion, on demand, instead.
    if (!asked && Date.now() - startedAt >= COPY_WAIT_MILLISECONDS && (await ask()) === "gone") return;
  }
}
