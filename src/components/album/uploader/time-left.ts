/*
 * The time a big upload has left, in calm words (Ruling BE): "about 2 minutes left". It follows the
 * bytes measured going out, not a guess at the connection: the rate is smoothed over the last few
 * seconds (a part retrying for a moment shouldn't send it to the moon), and the words change at
 * most every few seconds, so they don't flicker as parts finish. It ships with the uploader.
 */

/** How quickly the rate follows a change: the time it takes to move about two-thirds of the way. */
const RATE_SETTLE_MILLISECONDS = 8_000;
/** Sending measured for this long before there is a guess. */
const MEASURED_FOR_MILLISECONDS = 3_000;
/** The words change at most this often. */
const WORDS_HOLD_MILLISECONDS = 6_000;

/** Seconds left, rounded the way a person says it. */
export function timeLeftWords(seconds: number): string {
  if (seconds < 50) return "less than a minute left";
  if (seconds < 90) return "about a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes left`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? "about an hour left" : `about ${hours} hours left`;
}

export class TimeLeft {
  readonly #holdMs: number;
  #startedAt: number | null = null;
  #last: { at: number; sent: number } | null = null;
  /** Bytes a millisecond, smoothed. */
  #rate: number | null = null;
  #remaining = 0;
  #shown: { words: string; at: number } | null = null;

  constructor(options: { holdMs?: number } = {}) {
    this.#holdMs = options.holdMs ?? WORDS_HOLD_MILLISECONDS;
  }

  /** A reading at `now`: every byte sent so far (it only grows), and the bytes still to send. */
  sample(now: number, sentBytes: number, remainingBytes: number): void {
    this.#remaining = Math.max(0, remainingBytes);
    this.#startedAt ??= now;
    const last = this.#last;
    if (!last) {
      this.#last = { at: now, sent: sentBytes };
      return;
    }
    const elapsed = now - last.at;
    // Readings closer together than this say more about the timer than the connection.
    if (elapsed < 200) return;
    const rate = Math.max(0, sentBytes - last.sent) / elapsed;
    const weight = 1 - Math.exp(-elapsed / RATE_SETTLE_MILLISECONDS);
    this.#rate = this.#rate === null ? rate : this.#rate + (rate - this.#rate) * weight;
    this.#last = { at: now, sent: sentBytes };
  }

  /** Seconds left at the smoothed rate; null until sending has been measured for a few seconds. */
  seconds(): number | null {
    if (this.#rate === null || this.#startedAt === null || this.#last === null) return null;
    if (this.#last.at - this.#startedAt < MEASURED_FOR_MILLISECONDS) return null;
    if (this.#rate <= 0) return null;
    return this.#remaining / this.#rate / 1000;
  }

  /** The time left in words, held for a few seconds once shown. */
  words(now: number): string | null {
    const seconds = this.seconds();
    if (seconds === null) return this.#shown?.words ?? null;
    const words = timeLeftWords(seconds);
    if (!this.#shown || (words !== this.#shown.words && now - this.#shown.at >= this.#holdMs)) {
      this.#shown = { words, at: now };
    }
    return this.#shown.words;
  }

  /** Forgets everything: the next files are measured afresh. */
  reset(): void {
    this.#startedAt = null;
    this.#last = null;
    this.#rate = null;
    this.#remaining = 0;
    this.#shown = null;
  }
}
