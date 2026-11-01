/**
 * The longest a recorded wish plays, in seconds: the phone's recorder stops itself there, and the
 * worker trims anything longer (a recording from the phone's own camera or recorder) to it. Its own
 * tiny module, so the wishes page's first load carries this and not the upload allowlists beside it
 * in limits.ts, which re-exports it.
 */
export const WISH_SECONDS = { voice: 60, video: 30 } as const;
