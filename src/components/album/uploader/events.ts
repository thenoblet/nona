import type { ApiClient } from "./api";

/*
 * What the phone saw while uploading (a part retried, a file failed), sent to /api/upload-events
 * for the couple's status page: a few at a time, a moment after they happen, and whatever is left
 * as the page closes. Never shown to the guest, and never in the way: a refusal or no connection
 * just loses them.
 */

export type UploadEvent = {
  kind: "part-retry" | "failed";
  mediaId?: string;
  /** A short code: "network-error", "http-403", "stalled", "processing-corrupt"… */
  reason?: string;
  detail?: {
    partNumber?: number;
    attempt?: number;
    httpStatus?: number;
    online?: boolean;
    elapsedMs?: number;
    errorName?: string;
    /** Why the phone couldn't read a file: the browser's short words, with no file name or path. */
    errorMessage?: string;
    /** Which of the fingerprint's reads failed. */
    read?: "head" | "tail";
  };
};

/** The most the route takes at once. */
const EVENTS_PER_REQUEST = 20;
const SEND_AFTER_MILLISECONDS = 2_000;

export class EventReporter {
  readonly #api: ApiClient;
  readonly #waiting: UploadEvent[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #stopHearingPageHide: () => void;

  /** `onPageHide` registers what runs as the page goes, to send what is left, and returns what stops it. */
  constructor(api: ApiClient, onPageHide: (listener: () => void) => () => void) {
    this.#api = api;
    this.#stopHearingPageHide = onPageHide(() => this.#send(true));
  }

  /** Sends what is waiting now, and stops listening for the page going (its uploader has gone). */
  dispose(): void {
    this.#send(false);
    this.#stopHearingPageHide();
  }

  report(event: UploadEvent): void {
    this.#waiting.push(event);
    if (this.#waiting.length >= EVENTS_PER_REQUEST) this.#send(false);
    else this.#timer ??= setTimeout(() => this.#send(false), SEND_AFTER_MILLISECONDS);
  }

  #send(closing: boolean): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    while (this.#waiting.length > 0) {
      const events = this.#waiting.splice(0, EVENTS_PER_REQUEST);
      this.#api
        .request("/api/upload-events", { method: "POST", body: { events }, timeoutMs: 10_000, keepalive: closing })
        .catch(() => {});
    }
  }
}
