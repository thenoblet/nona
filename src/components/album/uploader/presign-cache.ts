/*
 * The presigned part URLs of one upload. The upload API signs up to 20 parts a call, so one call
 * serves the next 20 parts, and parts asked for at once (six are in flight) share it. The first
 * call asks only for the parts sent at once (`firstBatch`, Ruling AY): it follows the start, so a
 * burst of starts after the speeches signs a few parts each rather than twenty. Each link is handed
 * out once: a part asked for again is retrying (its connection dropped, or its link expired), so it
 * gets a fresh one. A link is valid for an hour; one fetched more than fifty minutes ago is fetched
 * again rather than risked.
 */

export type PartUrl = { partNumber: number; url: string };

/** The most part numbers one /parts call signs (MAX_PARTS_PER_PRESIGN on the server). */
export const PARTS_PER_PRESIGN = 20;
const LINK_SAFE_MILLISECONDS = 50 * 60 * 1000;

type CachedUrl = { url: string; fetchedAt: number };

export class PartUrlCache {
  readonly #partCount: number;
  readonly #uploaded: ReadonlySet<number>;
  readonly #fetchUrls: (partNumbers: number[], signal?: AbortSignal) => Promise<PartUrl[]>;
  readonly #now: () => number;
  readonly #urls = new Map<number, CachedUrl>();
  readonly #pending = new Map<number, Promise<void>>();
  /** How many parts the next call asks for: `firstBatch` the first time, then PARTS_PER_PRESIGN. */
  #batchSize: number;

  constructor(options: {
    partCount: number;
    /** The parts R2 already holds: never asked for. */
    uploadedParts: Iterable<number>;
    fetchUrls: (partNumbers: number[], signal?: AbortSignal) => Promise<PartUrl[]>;
    /** The first call's parts: those sent at once. Twenty when not given. */
    firstBatch?: number;
    now?: () => number;
  }) {
    this.#partCount = options.partCount;
    this.#uploaded = new Set(options.uploadedParts);
    this.#fetchUrls = options.fetchUrls;
    this.#batchSize = Math.min(PARTS_PER_PRESIGN, Math.max(1, options.firstBatch ?? PARTS_PER_PRESIGN));
    this.#now = options.now ?? (() => Date.now());
  }

  /** A PUT URL for this part, fetched with the parts after it that are still to send. */
  async urlFor(partNumber: number, signal?: AbortSignal): Promise<string> {
    const waiting = this.#pending.get(partNumber);
    if (waiting) {
      await waiting;
    } else if (!this.#fresh(partNumber)) {
      await this.#fetchFrom(partNumber, signal);
    }
    const cached = this.#urls.get(partNumber);
    if (!cached) throw new Error(`The server sent no link for part ${partNumber}`);
    this.#urls.delete(partNumber);
    return cached.url;
  }

  #fresh(partNumber: number): boolean {
    const cached = this.#urls.get(partNumber);
    if (!cached) return false;
    if (this.#now() - cached.fetchedAt < LINK_SAFE_MILLISECONDS) return true;
    this.#urls.delete(partNumber);
    return false;
  }

  /** Fetches this part and the next ones that have no fresh link, aren't being fetched and aren't in R2. */
  #fetchFrom(partNumber: number, signal?: AbortSignal): Promise<void> {
    const batch = [partNumber];
    const batchSize = this.#batchSize;
    this.#batchSize = PARTS_PER_PRESIGN;
    for (let next = partNumber + 1; next <= this.#partCount && batch.length < batchSize; next += 1) {
      if (!this.#uploaded.has(next) && !this.#pending.has(next) && !this.#fresh(next)) batch.push(next);
    }
    const fetching = this.#fetchUrls(batch, signal).then((urls) => {
      const fetchedAt = this.#now();
      for (const { partNumber: signed, url } of urls) this.#urls.set(signed, { url, fetchedAt });
    });
    // Every part of the batch waits on this one promise; whoever asked first handles its failure.
    const settled = fetching.finally(() => {
      for (const signed of batch) if (this.#pending.get(signed) === settled) this.#pending.delete(signed);
    });
    for (const signed of batch) this.#pending.set(signed, settled);
    return settled;
  }
}
