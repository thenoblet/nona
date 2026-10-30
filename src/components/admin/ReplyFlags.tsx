"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { keepBothAction, keepReplyAction } from "@/app/admin/rsvps/actions";
import type { ReplyFlag } from "@/lib/admin/replies";

const NOT_SAVED = "That didn't save. Check the connection, reload the page and try again.";

function others(count: number): string {
  return count === 1 ? "1 other" : `${count} others`;
}

/**
 * A flagged reply's notes and the couple's two choices: "Keep this one" (after an inline confirm)
 * moves the flagged replies shown here into this one's history, and nothing at all if another has
 * arrived since; "Keep both" clears the flag for one pair.
 * Each action re-renders the page on the server, so the list shows the new state without a reload,
 * and `onDone` gets a sentence saying what happened.
 */
export function ReplyFlags({
  replyId,
  replyName,
  flags,
  onDone,
}: {
  replyId: string;
  replyName: string;
  flags: ReplyFlag[];
  onDone: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const questionId = useId();
  const keepButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusKeepNext = useRef(false);

  // Opening the confirm puts focus on its safe choice; cancelling returns it to "Keep this one".
  useEffect(() => {
    if (confirming) {
      cancelButton.current?.focus();
    } else if (focusKeepNext.current) {
      focusKeepNext.current = false;
      keepButton.current?.focus();
    }
  }, [confirming]);

  type Outcome = { ok: true; moved?: number } | { ok: false; error: string };
  function run(action: () => Promise<Outcome>, done: (moved: number) => string) {
    setError(null);
    startTransition(async () => {
      let result: Outcome;
      try {
        result = await action();
      } catch {
        // Nothing changed and the page was not re-rendered, so the message stays by the buttons.
        setError(NOT_SAVED);
        return;
      }
      setConfirming(false);
      // A refusal means the page was out of date. It has just been re-rendered and this reply may
      // be gone from it, so the list says what happened.
      onDone(result.ok ? done(result.moved ?? 0) : result.error);
    });
  }

  const keepThisOne = () =>
    run(
      () =>
        keepReplyAction(
          replyId,
          flags.map((flag) => flag.otherId),
        ),
      (moved) =>
        moved > 0 ? `Kept ${replyName}'s reply and moved ${others(moved)} to its history.` : `Kept ${replyName}'s reply.`,
    );
  // The same guest's two replies are named once; two people's replies are both named.
  const bothOf = (flag: ReplyFlag) =>
    flag.kind === "replied-again" ? `both of ${replyName}'s replies` : `both, ${replyName} and ${flag.otherName}`;
  const keepBoth = (flag: ReplyFlag) =>
    run(
      () => keepBothAction(replyId, flag.otherId),
      () => `Kept ${bothOf(flag)}.`,
    );
  const cancel = () => {
    focusKeepNext.current = true;
    setConfirming(false);
  };

  const keepBothButton = (flag: ReplyFlag) => (
    <button
      type="button"
      className="admin-flag-btn"
      disabled={pending}
      aria-label={`Keep both, this reply and ${flag.otherName}'s${flag.otherReceived ? ` from ${flag.otherReceived}` : ""}`}
      onClick={() => keepBoth(flag)}
    >
      Keep both
    </button>
  );

  return (
    <div className="admin-flags" aria-busy={pending} data-pending={pending ? "" : undefined}>
      <ul className="admin-flag-list">
        {flags.map((flag) => (
          <li key={flag.otherId}>
            <span className="admin-flag-note">{flag.note}</span>
            {flags.length > 1 && keepBothButton(flag)}
          </li>
        ))}
      </ul>
      {confirming ? (
        <div className="admin-confirm" role="group" aria-labelledby={questionId}>
          <p id={questionId}>Keep this reply and move {others(flags.length)} to its history?</p>
          <div className="admin-flag-actions">
            <button type="button" className="admin-flag-btn admin-flag-btn-primary" disabled={pending} onClick={keepThisOne}>
              {pending ? "Keeping…" : "Yes, keep this one"}
            </button>
            <button ref={cancelButton} type="button" className="admin-flag-btn" disabled={pending} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-flag-actions">
          <button
            ref={keepButton}
            type="button"
            className="admin-flag-btn"
            disabled={pending}
            aria-label={`Keep this one, ${replyName}`}
            onClick={() => setConfirming(true)}
          >
            Keep this one
          </button>
          {flags.length === 1 && keepBothButton(flags[0])}
        </div>
      )}
      {error && (
        <p className="admin-flag-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
