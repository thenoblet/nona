"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { deleteReplyAction } from "@/app/admin/rsvps/actions";
import type { DeleteResult } from "@/lib/data/rsvp";

const NOT_DELETED = "That didn't delete. Check the connection, reload the page and try again.";

/**
 * A reply's "Delete": a quiet link that opens an inline confirm, its safe choice focused, saying what
 * goes (the reply, and its earlier replies if it has any). Deleting re-renders the page on the
 * server, so the reply leaves the list and the totals at once, and `onDone` says what happened.
 */
export function ReplyDelete({
  replyId,
  replyName,
  earlierCount,
  onDone,
}: {
  replyId: string;
  replyName: string;
  earlierCount: number;
  onDone: (message: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const questionId = useId();
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusDeleteNext = useRef(false);

  // Opening the confirm puts focus on Cancel; cancelling returns it to "Delete".
  useEffect(() => {
    if (confirming) {
      cancelButton.current?.focus();
    } else if (focusDeleteNext.current) {
      focusDeleteNext.current = false;
      deleteButton.current?.focus();
    }
  }, [confirming]);

  const earlier = earlierCount === 0 ? "" : earlierCount === 1 ? " and its earlier reply" : ` and its ${earlierCount} earlier replies`;

  const remove = () => {
    setError(null);
    startTransition(async () => {
      let result: DeleteResult;
      try {
        result = await deleteReplyAction(replyId);
      } catch {
        // Nothing changed and the page was not re-rendered, so the message stays by the buttons.
        setError(NOT_DELETED);
        return;
      }
      setConfirming(false);
      onDone(result.ok ? `Deleted ${replyName}'s reply${earlier}.` : result.error);
    });
  };
  const cancel = () => {
    focusDeleteNext.current = true;
    setConfirming(false);
  };

  return (
    <div className="admin-delete" aria-busy={pending}>
      {confirming ? (
        <div className="admin-confirm admin-confirm-danger" role="group" aria-labelledby={questionId}>
          <p id={questionId}>
            Delete {replyName}&apos;s reply{earlier}? It comes off the list and the totals for good.
          </p>
          <div className="admin-flag-actions">
            <button type="button" className="admin-flag-btn admin-flag-btn-danger" disabled={pending} onClick={remove}>
              {pending ? "Deleting…" : "Yes, delete"}
            </button>
            <button ref={cancelButton} type="button" className="admin-flag-btn" disabled={pending} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={deleteButton}
          type="button"
          className="admin-linkbtn"
          aria-label={`Delete ${replyName}'s reply`}
          onClick={() => setConfirming(true)}
        >
          Delete
        </button>
      )}
      {error && (
        <p className="admin-flag-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
