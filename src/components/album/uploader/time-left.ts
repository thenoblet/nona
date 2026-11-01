/*
 * The time a big upload has left, in calm words (Ruling BE): "about 2 minutes left". It follows the
 * bytes measured going out, not a guess at the connection: the rate is smoothed over the last few
 * seconds, and the words change at most every few seconds, so they don't flicker as parts finish.
 *
 * It never extrapolates a stall. While nothing moves (a part retrying, the phone offline, no byte
 * out for a few seconds) there is no estimate at all, rather than one that balloons to hours; when
 * bytes move again the clock carries on from there, the stall left out of the rate. Past half an
 * hour it says only that this may take a while. It ships with the uploader.
 */

/** How quickly the rate follows a change: the time it takes to move about two-thirds of the way. */
const RATE_SETTLE_MILLISECONDS = 8_000;
/** Bytes measured moving for this long before there is a guess. */
const MEASURED_FOR_MILLISECONDS = 3_000;
/** No byte out for this long is a stall. */
const STALLED_AFTER_MILLISECONDS = 3_000;
/** The words change at most this often. */
const WORDS_HOLD_MILLISECONDS = 6_000;
/** Past this, a number would only be a guess: "this may take a while". */
const LONGEST_ESTIMATE_SECONDS = 30 * 60;

/** Seconds left, rounded the way a person says it. */
export function timeLeftWords(seconds: number): string {
  if (seconds > LONGEST_ESTIMATE_SECONDS) return "this may take a while";
  if (seconds < 50) return "less than a minute left";
  if (seconds < 90) return "about a minute left";
  return `about ${Math.round(seconds / 60)} minutes left`;
}

/** A reading of the uploads at one moment. */
export type TimeLeftReading = {
  /** Every byte sent so far (it only grows). */
  sentBytes: number;
  /** The bytes still to send. */
  remainingBytes: number;
  /** Nothing can move now: a part is retrying, or the phone is offline. */
  held: boolean;
};

export type TimeLeftEstimate = { seconds: number; words: string };

export class TimeLeft {
  readonly #holdMs: number;
  /** When bytes were first seen moving, for the first guess's wait. */
  #movingSince: number | null = null;
  /** The last reading the rate runs from, and when bytes last moved. */
  #last: { at: number; sent: number } | null = null;
  #lastMovedAt: number | null = null;
  /** Bytes a millisecond, smoothed. */
  #rate: number | null = null;
  #shown: { words: string; at: number } | null = null;

  constructor(options: { holdMs?: number } = {}) {
    this.#holdMs = options.holdMs ?? WORDS_HOLD_MILLISECONDS;
  }

  /**
   * Takes a reading at `now` and answers the time left, or null while there is nothing honest to
   * say: before bytes have moved for a few seconds, during a stall, and once nothing is left to send.
   */
  read(now: number, reading: TimeLeftReading): TimeLeftEstimate | null {
    const last = this.#last;
    const moved = last !== null && reading.sentBytes > last.sent;
    if (moved || (last === null && reading.sentBytes > 0)) this.#lastMovedAt = now;
    const stalled = reading.held || this.#lastMovedAt === null || now - this.#lastMovedAt >= STALLED_AFTER_MILLISECONDS;
    if (stalled || last === null) {
      // The clock carries on from here: the stall stays out of the rate.
      this.#last = { at: now, sent: reading.sentBytes };
      if (!stalled) this.#movingSince ??= now;
      return null;
    }
    // A moment with nothing out (less than a stall) changes nothing yet: the next bytes' interval
    // counts it, at its real length, so a hiccup weighs what it cost and no more.
    const elapsed = now - last.at;
    if (moved && elapsed >= 200) {
      const rate = (reading.sentBytes - last.sent) / elapsed;
      const weight = 1 - Math.exp(-elapsed / RATE_SETTLE_MILLISECONDS);
      this.#rate = this.#rate === null ? rate : this.#rate + (rate - this.#rate) * weight;
      this.#last = { at: now, sent: reading.sentBytes };
    }
    this.#movingSince ??= last.at;
    if (reading.remainingBytes <= 0) return null;
    if (this.#rate === null || this.#rate <= 0 || now - this.#movingSince < MEASURED_FOR_MILLISECONDS) return null;
    const seconds = reading.remainingBytes / this.#rate / 1000;
    return { seconds, words: this.#words(now, seconds) };
  }

  /** The words for `seconds`; once they change, they hold for a few seconds before changing again. */
  #words(now: number, seconds: number): string {
    const words = timeLeftWords(seconds);
    if (!this.#shown || (words !== this.#shown.words && now - this.#shown.at >= this.#holdMs)) {
      this.#shown = { words, at: now };
    }
    return this.#shown.words;
  }

  /** Forgets everything: the next files are measured afresh. */
  reset(): void {
    this.#movingSince = null;
    this.#last = null;
    this.#lastMovedAt = null;
    this.#rate = null;
    this.#shown = null;
  }
}
