import { ApiError, type ApiAnswer } from "./api";
import { UPLOAD_WORDS, type UploadFailure } from "./state";

/*
 * What each answer from the upload API, and each error on the way, means for a file. Only a
 * complete that says the file was uploaded (or is ready) adds it; anything the uploader doesn't
 * recognise is a failure, never success. A failure carries a short code for the status page
 * (/api/upload-events takes [a-z0-9-] only) and plain words for the guest.
 */

export type Outcome =
  | { kind: "added" }
  /** Settled: show `failure`; Try again only where it can help. */
  | { kind: "failed"; code: string; failure: UploadFailure }
  /** Passing trouble (a dropped connection, a server briefly down, parts still arriving): carry on by itself. */
  | { kind: "retry"; code: string };

export type UploadSession = {
  mediaId: string;
  uploadId: string;
  key: string;
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; etag: string; size: number }[];
};

type ErrorBody = { error?: unknown; message?: unknown; status?: unknown; reason?: unknown } | null;

const CODE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function bodyOf(answer: ApiAnswer): ErrorBody {
  return answer.body && typeof answer.body === "object" ? (answer.body as ErrorBody) : null;
}

/** The answer's error code, if it is one the events take; else its HTTP status. */
function codeOf(answer: ApiAnswer): string {
  const error = bodyOf(answer)?.error;
  return typeof error === "string" && CODE.test(error) ? error : `http-${answer.status}`;
}

/** The server's own plain words for the guest, or ours when it sent none. */
function messageOf(answer: ApiAnswer, fallback: string): string {
  const message = bodyOf(answer)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

function failed(code: string, reason: string, canRetry: boolean, hint: string | null = null): Outcome {
  return { kind: "failed", code, failure: { reason, hint, canRetry } };
}

/** The guest's words for a reason the worker failed a file with; trying the same bytes again can't help. */
function processingFailure(reason: unknown): Outcome {
  const code = typeof reason === "string" && CODE.test(reason) ? reason : "unknown";
  return failed(`processing-${code}`.slice(0, 64), code === "too-large" ? UPLOAD_WORDS.tooLargeToShow : UPLOAD_WORDS.unreadable, false);
}

/** 403, 404, 409 and 5xx, as every upload route answers them. */
function refusalOutcome(answer: ApiAnswer): Outcome {
  if (answer.status === 429) return { kind: "retry", code: "rate-limited" };
  if (answer.status >= 500) return { kind: "retry", code: `http-${answer.status}` };
  const code = codeOf(answer);
  if (code === "uploads-closed") return failed(code, messageOf(answer, UPLOAD_WORDS.notSent), false);
  if (answer.status === 409) return failed(code, messageOf(answer, UPLOAD_WORDS.notSent), true);
  // 403 (the upload isn't this browser's: a cookie lost meanwhile), 404 (its row gone), anything else.
  return failed(code, UPLOAD_WORDS.notSent, true);
}

/** POST /api/uploads/[id]/complete. */
export function completionOutcome(answer: ApiAnswer): Outcome {
  if (answer.status === 200) {
    const status = bodyOf(answer)?.status;
    if (status === "uploaded" || status === "ready") return { kind: "added" };
    if (status === "failed") return processingFailure(bodyOf(answer)?.reason);
    return failed("unexpected-answer", UPLOAD_WORDS.notSent, true);
  }
  if (answer.status === 409 && codeOf(answer) === "incomplete") return { kind: "retry", code: "incomplete" };
  return refusalOutcome(answer);
}

/**
 * A complete sent again for a file this phone already asked to complete (its answer lost):
 * `continue` when the upload is still unfinished (start resumes it), `forget` when it is gone or
 * no longer this browser's (start afresh).
 */
export function probeOutcome(answer: ApiAnswer): Outcome | { kind: "continue" } | { kind: "forget" } {
  if (answer.status === 200) return completionOutcome(answer);
  if (answer.status === 409 && codeOf(answer) === "incomplete") return { kind: "continue" };
  if (answer.status === 429 || answer.status >= 500 || codeOf(answer) === "uploads-closed") return refusalOutcome(answer);
  return { kind: "forget" };
}

function isSession(body: unknown): body is UploadSession {
  const session = body as Partial<UploadSession> | null;
  return (
    typeof session?.mediaId === "string" &&
    typeof session.uploadId === "string" &&
    typeof session.key === "string" &&
    typeof session.partCount === "number" &&
    Array.isArray(session.uploadedParts)
  );
}

/** POST /api/uploads. */
export function startOutcome(answer: ApiAnswer): Outcome | { kind: "session"; session: UploadSession } {
  if (answer.status === 200) {
    return isSession(answer.body) ? { kind: "session", session: answer.body } : failed("unexpected-answer", UPLOAD_WORDS.notSent, true);
  }
  // A file the album doesn't take (type, size, empty): the API's own words, and nothing to try again.
  if (answer.status === 400) return failed(codeOf(answer), messageOf(answer, UPLOAD_WORDS.notSent), false);
  // The browser lost its guest meanwhile (cleared cookies): the uploader asks for one again.
  if (codeOf(answer) === "no-guest") return { kind: "retry", code: "no-guest" };
  return refusalOutcome(answer);
}

/** GET or POST /api/uploads/[id]/parts. */
export function partsOutcome(answer: ApiAnswer): Outcome | { kind: "ok"; body: unknown } {
  if (answer.status === 200) return { kind: "ok", body: answer.body };
  return refusalOutcome(answer);
}

/** Thrown inside Uppy's callbacks to carry an outcome out to the uploader. */
export class OutcomeError extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome.kind === "added" ? "added" : outcome.code);
    this.name = "OutcomeError";
  }
}

/**
 * What an error means: the guest cancelled; an outcome a callback carried out; a call that got no
 * answer or a part whose PUT failed past its retries (carry on by itself); a file the phone can't
 * read (it moved, or lives in a cloud the phone can't reach now), which Try again reads afresh.
 */
export function errorOutcome(error: unknown): Outcome | { kind: "cancelled" } {
  if (error instanceof OutcomeError) return error.outcome;
  if (error instanceof ApiError) return { kind: "retry", code: error.kind === "timeout" ? "timeout" : "network-error" };
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError") return { kind: "cancelled" };
  if (name === "NotReadableError" || name === "NotFoundError") return failed("unreadable", UPLOAD_WORDS.unreadable, true);
  const status = (error as { source?: { status?: unknown } } | null)?.source?.status;
  if (typeof status === "number" && status > 0) return { kind: "retry", code: `http-${status}` };
  return { kind: "retry", code: "network-error" };
}
