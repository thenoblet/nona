import { ApiError, type ApiAnswer } from "./api";
import type { FileRead } from "./fingerprint";
import { UPLOAD_WORDS, type UploadFailure } from "./state";

/*
 * What each answer from the upload API, and each error on the way, means for a file. Only a
 * complete that says the file was uploaded (or is ready) adds it; anything the uploader doesn't
 * recognise is a failure, never success. A failure carries a short code for the status page
 * (/api/upload-events takes [a-z0-9-] only) and plain words for the guest.
 */

/**
 * Why the phone couldn't read a file, for the status page (Ruling BA): the browser's error name, its
 * own words (short, with the file's name and any path taken out) and which read failed.
 */
export type ReadFailureDetail = { errorName: string; errorMessage: string; read?: FileRead };

export type Outcome =
  | { kind: "added" }
  /** Settled: show `failure`; Try again only where it can help. */
  | { kind: "failed"; code: string; failure: UploadFailure; detail?: ReadFailureDetail }
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

/** Sharing closed: a short title, the server's own thank-you beneath it, and nothing to try again. */
function closedOutcome(answer: ApiAnswer): Outcome {
  const message = messageOf(answer, "");
  return {
    kind: "failed",
    code: "uploads-closed",
    failure: { reason: UPLOAD_WORDS.sharingClosed, hint: message || null, canRetry: false, closed: true },
  };
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
  if (code === "uploads-closed") return closedOutcome(answer);
  // The couple hid it (or deleted it): sending it again must never get round that.
  if (code === "hidden") return failed(code, UPLOAD_WORDS.cantAdd, false);
  // Try again starts the upload afresh, which is what the guest needs.
  if (code === "upload-missing") return failed(code, UPLOAD_WORDS.expired, true);
  // The file changed since it was picked: only picking it again helps, as the server's words say.
  if (code === "size-mismatch") return failed(code, messageOf(answer, UPLOAD_WORDS.notSent), false);
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
 * A complete sent again for a file this phone already asked to complete (its answer lost, or the
 * file picked again later): `continue` when the upload is still unfinished (start resumes it);
 * `forget` when it is gone, no longer this browser's, or removed by the guest (who, picking it
 * again, wants it back: start afresh); the couple's hiding stands.
 */
export function probeOutcome(answer: ApiAnswer): Outcome | { kind: "continue" } | { kind: "forget" } {
  if (answer.status === 200) return completionOutcome(answer);
  const code = codeOf(answer);
  if (answer.status === 409 && code === "incomplete") return { kind: "continue" };
  if (answer.status === 429 || answer.status >= 500 || code === "uploads-closed" || code === "hidden") {
    return refusalOutcome(answer);
  }
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

/** The most of the browser's words kept with a read failure. */
const MESSAGE_LENGTH = 120;

/**
 * The browser's words for a failed read, safe to send: the file's name, any path or URI and any
 * file-like name taken out, then cut short. Chrome's own words name no file, but a phone's may.
 */
function scrubbedMessage(message: string, fileName: string): string {
  let scrubbed = message;
  if (fileName) scrubbed = scrubbed.split(fileName).join("");
  scrubbed = scrubbed
    // URIs (content://, file://, blob:) and paths, Android's and Windows' alike.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "")
    .replace(/\bblob:\S*/gi, "")
    .replace(/(?:[A-Za-z]:)?[\\/][^\s)]*/g, "")
    // Anything left that looks like a file's name.
    .replace(/\S+\.[A-Za-z0-9]{2,5}\b/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([:,.)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s(]+$/, "")
    .trim();
  return scrubbed.slice(0, MESSAGE_LENGTH);
}

/**
 * A file the phone can no longer read (Ruling BA): Chrome's File is a snapshot, and once the file
 * changes on disk after the pick (WhatsApp or the phone finishing it) every read fails, as the File
 * API asks. Reading the same File again can't help; picking it again does, so the failure offers
 * Choose again rather than Try again.
 */
function fileChangedOutcome(error: unknown, file: { kind: "photo" | "video"; name: string } | undefined): Outcome {
  const original = error as { name?: unknown; message?: unknown; read?: unknown } | null;
  const read = original?.read === "head" || original?.read === "tail" ? original.read : undefined;
  return {
    kind: "failed",
    code: "file-changed",
    failure: {
      reason: file?.kind === "video" ? UPLOAD_WORDS.videoChanged : UPLOAD_WORDS.photoChanged,
      hint: UPLOAD_WORDS.chooseItAgain,
      canRetry: false,
      chooseAgain: true,
    },
    detail: {
      errorName: String(original?.name ?? "Error").slice(0, 100),
      errorMessage: scrubbedMessage(typeof original?.message === "string" ? original.message : "", file?.name ?? ""),
      ...(read ? { read } : {}),
    },
  };
}

/** Whether an error says the phone couldn't read the file (it changed, moved or went). */
export function isUnreadable(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotReadableError" || name === "NotFoundError";
}

/**
 * What an error means: the guest cancelled; an outcome a callback carried out; a call that got no
 * answer or a part whose PUT failed past its retries (carry on by itself); a file the phone can no
 * longer read (it changed after it was picked), which only choosing it again can help. `file` says
 * which file, for the words and to keep its name out of what is reported.
 */
export function errorOutcome(error: unknown, file?: { kind: "photo" | "video"; name: string }): Outcome | { kind: "cancelled" } {
  if (error instanceof OutcomeError) return error.outcome;
  if (error instanceof ApiError) return { kind: "retry", code: error.kind === "timeout" ? "timeout" : "network-error" };
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError") return { kind: "cancelled" };
  if (isUnreadable(error)) return fileChangedOutcome(error, file);
  const status = (error as { source?: { status?: unknown } } | null)?.source?.status;
  if (typeof status === "number" && status > 0) return { kind: "retry", code: `http-${status}` };
  return { kind: "retry", code: "network-error" };
}
