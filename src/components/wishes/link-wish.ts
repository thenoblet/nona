import type { RecordedWishState } from "@/app/(site)/wishes/actions";

/*
 * Making the wish of a recording once the server has it (sendRecordedWish), as the sending card does:
 * past the guest's limit it waits Retry-After's time and asks again, never showing it (global
 * constraints); with no answer, or none within 20 s (a call across the network always has a
 * timeout), it asks a few more times, the same recording answering the same wish each time.
 */

export type LinkInput = { kind: "voice" | "video"; mediaId: string; signedAs: string };

export type LinkTimings = {
  /** The waits before asking again after no answer: about half a minute in all. */
  retryMilliseconds: readonly number[];
  /** How long one ask may take before it counts as no answer. */
  timeoutMilliseconds: number;
  /** The longest a rate limit's wait is taken at its word. */
  maxRateLimitWaitSeconds: number;
  sleep: (milliseconds: number) => Promise<void>;
};

export const LINK_TIMINGS: LinkTimings = {
  retryMilliseconds: [1_000, 3_000, 7_000, 15_000],
  timeoutMilliseconds: 20_000,
  maxRateLimitWaitSeconds: 60,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const DIDNT_SEND = "Your wish didn't send. Please try again.";

/** `work`, or a rejection once it has taken longer than `milliseconds`. */
function withinTime<TValue>(work: Promise<TValue>, milliseconds: number): Promise<TValue> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No answer in time")), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Asks `send` for the wish until it answers sent, refused or an error; a rate limit is waited out, unseen. */
export async function linkWish(
  input: LinkInput,
  send: (input: LinkInput) => Promise<RecordedWishState>,
  timings: LinkTimings = LINK_TIMINGS,
): Promise<RecordedWishState> {
  for (let attempt = 0; ; ) {
    try {
      const state = await withinTime(send(input), timings.timeoutMilliseconds);
      if (state.status !== "rate-limited") return state;
      await timings.sleep(Math.min(Math.max(1, state.retryAfterSeconds), timings.maxRateLimitWaitSeconds) * 1000);
    } catch {
      if (attempt >= timings.retryMilliseconds.length) return { status: "error", message: DIDNT_SEND };
      await timings.sleep(timings.retryMilliseconds[attempt]);
      attempt += 1;
    }
  }
}
