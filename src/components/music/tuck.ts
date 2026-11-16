/**
 * Whether the music pill is tucked into its round button, and whether it is peeking: opened for a
 * few seconds by a new song, to show its name, before it tucks itself back.
 */
export type TuckState = { tucked: boolean; peeking: boolean };

export type TuckEvent =
  /** The guest tucked the pill away (the › or a swipe to the right). */
  | { type: "tuck" }
  /** The guest opened it again from the round button. */
  | { type: "open" }
  /** A new song started. */
  | { type: "songChanged" }
  /** The peek's few seconds are up. */
  | { type: "peekEnded" }
  /** The guest tapped or focused the pill while it peeked: they want it, so it stays open. */
  | { type: "touched" }
  /** What this browser remembered from last time. */
  | { type: "restore"; tucked: boolean };

export const openPill: TuckState = { tucked: false, peeking: false };

/** How long a new song's name shows before the pill tucks itself back. */
export const PEEK_MS = 3000;

export function tuckReducer(state: TuckState, event: TuckEvent): TuckState {
  switch (event.type) {
    case "tuck":
      return { tucked: true, peeking: false };
    case "open":
      return openPill;
    case "restore":
      return { tucked: event.tucked, peeking: false };
    case "songChanged":
      // Only a tucked pill peeks; an open one already shows the song.
      return state.tucked ? { tucked: true, peeking: true } : state;
    case "peekEnded":
      return state.peeking ? { tucked: true, peeking: false } : state;
    case "touched":
      return state.peeking ? openPill : state;
  }
}

/** Whether the pill shows (open, or peeking) rather than the round button. */
export function pillShown(state: TuckState): boolean {
  return !state.tucked || state.peeking;
}
