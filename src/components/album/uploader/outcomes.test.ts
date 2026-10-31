import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { FileReadError } from "./fingerprint";
import { completionOutcome, errorOutcome, probeOutcome, startOutcome } from "./outcomes";
import { UPLOAD_WORDS } from "./state";

const CLOSED = "Uploads to the album have closed. Thank you for every photo and video you shared!";

describe("what the server's answers mean for a file", () => {
  it("adds a file only on a complete that says it was uploaded", () => {
    expect(completionOutcome({ status: 200, body: { mediaId: "m", status: "uploaded" } })).toEqual({ kind: "added" });
    expect(completionOutcome({ status: 200, body: { mediaId: "m", status: "ready" } })).toEqual({ kind: "added" });
  });

  it("shows a complete that says failed as the failure, with its reason, never as added", () => {
    expect(completionOutcome({ status: 200, body: { mediaId: "m", status: "failed", reason: "corrupt" } })).toEqual({
      kind: "failed",
      code: "processing-corrupt",
      failure: { reason: UPLOAD_WORDS.unreadable, hint: null, canRetry: false },
    });
    expect(completionOutcome({ status: 200, body: { mediaId: "m", status: "failed", reason: "too-large" } })).toMatchObject({
      kind: "failed",
      failure: { reason: "This file is too large for the album", canRetry: false },
    });
    // An answer it doesn't know is never taken for success.
    expect(completionOutcome({ status: 200, body: { mediaId: "m", status: "something-new" } }).kind).toBe("failed");
    expect(completionOutcome({ status: 200, body: null }).kind).toBe("failed");
  });

  it("carries on by itself when parts haven't all arrived, or the server is briefly down", () => {
    expect(completionOutcome({ status: 409, body: { error: "incomplete", message: "…" } })).toEqual({ kind: "retry", code: "incomplete" });
    expect(completionOutcome({ status: 503, body: { error: "unavailable" } })).toEqual({ kind: "retry", code: "http-503" });
  });

  it("fails an expired upload in words that fit its Try again, and a changed file in the server's, with none", () => {
    expect(completionOutcome({ status: 409, body: { error: "upload-missing", message: "This upload has expired. Please choose the file again." } })).toEqual({
      kind: "failed",
      code: "upload-missing",
      failure: { reason: "This upload expired before it arrived", hint: null, canRetry: true },
    });
    expect(completionOutcome({ status: 409, body: { error: "size-mismatch", message: "This file didn't match. Please choose it again." } })).toMatchObject({
      failure: { reason: "This file didn't match. Please choose it again.", canRetry: false },
    });
    expect(completionOutcome({ status: 409, body: { error: "invalid-parts", message: "Please send it again." } })).toMatchObject({
      failure: { reason: "Please send it again.", canRetry: true },
    });
    expect(completionOutcome({ status: 404, body: { error: "missing" } })).toMatchObject({
      code: "missing",
      failure: { reason: UPLOAD_WORDS.notSent, canRetry: true },
    });
  });

  it("fails with a short title over the plain closed message, and nothing to try again, once the couple close uploads", () => {
    expect(completionOutcome({ status: 403, body: { error: "uploads-closed", message: CLOSED } })).toEqual({
      kind: "failed",
      code: "uploads-closed",
      failure: { reason: "Sharing has closed", hint: CLOSED, canRetry: false, closed: true },
    });
    expect(startOutcome({ status: 403, body: { error: "uploads-closed", message: CLOSED } })).toMatchObject({
      failure: { reason: "Sharing has closed", hint: CLOSED, canRetry: false, closed: true },
    });
  });

  it("never adds a file the couple hid, picked again; one its guest removed starts afresh", () => {
    const cantAdd = { kind: "failed", code: "hidden", failure: { reason: "This one can't be added to the album", hint: null, canRetry: false } };
    expect(probeOutcome({ status: 409, body: { error: "hidden" } })).toEqual(cantAdd);
    expect(completionOutcome({ status: 409, body: { error: "hidden" } })).toEqual(cantAdd);
    expect(probeOutcome({ status: 409, body: { error: "removed" } })).toEqual({ kind: "forget" });
    // Ruling AX: a start of a file the couple hid, from any phone.
    expect(startOutcome({ status: 409, body: { error: "hidden" } })).toEqual(cantAdd);
  });

  it("starts a session, refuses a file in the API's words, and redoes the guest when the browser has none", () => {
    const session = { mediaId: "m", uploadId: "u", key: "k", partSize: 8, partCount: 1, uploadedParts: [] };
    expect(startOutcome({ status: 200, body: session })).toEqual({ kind: "session", session });
    expect(startOutcome({ status: 400, body: { error: "unsupported-type", message: "Only photos and videos can be shared here." } })).toEqual({
      kind: "failed",
      code: "unsupported-type",
      failure: { reason: "Only photos and videos can be shared here.", hint: null, canRetry: false },
    });
    expect(startOutcome({ status: 403, body: { error: "no-guest" } })).toEqual({ kind: "retry", code: "no-guest" });
    expect(startOutcome({ status: 502, body: null })).toEqual({ kind: "retry", code: "http-502" });
  });

  it("asks a remembered upload whether it finished: added, failed, still to finish, or gone", () => {
    expect(probeOutcome({ status: 200, body: { status: "uploaded" } })).toEqual({ kind: "added" });
    expect(probeOutcome({ status: 200, body: { status: "failed", reason: "corrupt" } }).kind).toBe("failed");
    expect(probeOutcome({ status: 409, body: { error: "incomplete" } })).toEqual({ kind: "continue" });
    for (const gone of [
      { status: 403, body: { error: "forbidden" } },
      { status: 409, body: { error: "upload-missing" } },
      { status: 404, body: { error: "missing" } },
    ]) {
      expect(probeOutcome(gone)).toEqual({ kind: "forget" });
    }
  });

  it("carries on after a dropped connection", () => {
    expect(errorOutcome(new ApiError("network", "Failed to fetch"))).toEqual({ kind: "retry", code: "network-error" });
    expect(errorOutcome(new ApiError("timeout", "timed out"))).toEqual({ kind: "retry", code: "timeout" });
    // A part's PUT that Uppy gave up on: the XHR's status rides on the error.
    expect(errorOutcome(Object.assign(new Error("Non 2xx"), { source: { status: 500 } }))).toEqual({ kind: "retry", code: "http-500" });
    expect(errorOutcome(Object.assign(new Error("Unknown error"), { source: { status: 0 } }))).toEqual({ kind: "retry", code: "network-error" });
    expect(errorOutcome(new DOMException("Aborted", "AbortError"))).toEqual({ kind: "cancelled" });
  });

  it("Ruling BA: says a file the phone can no longer read changed after it was chosen, with Choose again rather than Try again", () => {
    const stale = new DOMException(
      "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.",
      "NotReadableError",
    );
    expect(errorOutcome(new FileReadError("tail", stale), { kind: "photo", name: "IMG-20261205-WA0007.jpg" })).toEqual({
      kind: "failed",
      code: "file-changed",
      failure: { reason: "This photo changed after you chose it", hint: "Choose it again.", canRetry: false, chooseAgain: true },
      detail: {
        errorName: "NotReadableError",
        errorMessage: "The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.".slice(0, 120),
        read: "tail",
      },
    });
    expect(errorOutcome(new DOMException("Gone", "NotFoundError"), { kind: "video", name: "clip.mp4" })).toMatchObject({
      code: "file-changed",
      failure: { reason: "This video changed after you chose it", chooseAgain: true },
      detail: { errorName: "NotFoundError", errorMessage: "Gone" },
    });
  });

  it("never sends a file's name or path with why it couldn't be read", () => {
    const named = new DOMException(
      "A requested file or directory could not be found at the time an operation was processed: /storage/emulated/0/WhatsApp/Media/IMG-20261205-WA0007.jpg (content://media/external/images/media/42)",
      "NotFoundError",
    );
    const outcome = errorOutcome(new FileReadError("head", named), { kind: "photo", name: "IMG-20261205-WA0007.jpg" });
    const message = outcome.kind === "failed" ? (outcome.detail?.errorMessage ?? "") : "";
    expect(message).toContain("A requested file or directory could not be found");
    expect(message).not.toMatch(/IMG-20261205|WhatsApp|emulated|content:|\//);
    expect(message.length).toBeLessThanOrEqual(120);
  });
});
