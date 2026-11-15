"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { addViewerAction, removeViewerAction, type PeopleResult } from "@/app/admin/people/actions";

const NOT_SAVED = "That didn't save. Check the connection, reload the page and try again.";

type Viewer = { id: string; email: string; added: string };
type Notice = { text: string; tone: "ok" | "bad" };

/**
 * The viewers now, each with Remove (an inline confirm, its safe choice focused), and the form to
 * add one. Each action re-renders the page on the server, so the list shows the change at once.
 */
export function PeopleManager({ viewers }: { viewers: Viewer[] }) {
  const emailId = useId();
  const [adding, startAdding] = useTransition();
  const [addError, setAddError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setAddError(null);
    setNotice(null);
    startAdding(async () => {
      let result: PeopleResult;
      try {
        result = await addViewerAction(data);
      } catch {
        setAddError(NOT_SAVED);
        return;
      }
      if (result.ok) {
        form.current?.reset();
        setNotice({ text: result.message, tone: "ok" });
      } else {
        setAddError(result.error);
      }
    });
  };

  return (
    <section className="admin-people-card" aria-labelledby="people-viewers">
      <h2 id="people-viewers">Viewers</h2>
      <p className="admin-field-hint">Can read the Replies list and download it as Excel or CSV. Can&apos;t change anything.</p>
      {viewers.length === 0 ? (
        <p className="admin-people-empty">No viewers yet.</p>
      ) : (
        <ul className="admin-people-list">
          {viewers.map((viewer) => (
            <ViewerRow key={viewer.id} viewer={viewer} onDone={setNotice} />
          ))}
        </ul>
      )}
      <p className={`admin-notice${notice?.tone === "bad" ? " admin-notice-bad" : ""}`} role="status">
        {notice?.text}
      </p>
      <form ref={form} className="admin-people-add" onSubmit={add} aria-busy={adding} noValidate>
        <div className={`admin-field${addError ? " admin-field-invalid" : ""}`}>
          <label htmlFor={emailId}>Their email</label>
          <input
            id={emailId}
            name="email"
            type="email"
            autoComplete="off"
            inputMode="email"
            placeholder="name@example.com"
            required
            aria-invalid={addError ? true : undefined}
            aria-describedby={addError ? `${emailId}-error` : undefined}
            onChange={() => addError && setAddError(null)}
          />
          {addError && (
            <span id={`${emailId}-error`} className="admin-field-error">
              {addError}
            </span>
          )}
        </div>
        <button type="submit" className="admin-btn admin-btn-primary" aria-disabled={adding}>
          {adding ? "Adding…" : "Add viewer"}
        </button>
      </form>
    </section>
  );
}

function ViewerRow({ viewer, onDone }: { viewer: Viewer; onDone: (notice: Notice) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const questionId = useId();
  const removeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusRemoveNext = useRef(false);

  // Opening the confirm puts focus on Cancel; cancelling returns it to "Remove".
  useEffect(() => {
    if (confirming) {
      cancelButton.current?.focus();
    } else if (focusRemoveNext.current) {
      focusRemoveNext.current = false;
      removeButton.current?.focus();
    }
  }, [confirming]);

  const remove = () => {
    setError(null);
    startTransition(async () => {
      let result: PeopleResult;
      try {
        result = await removeViewerAction(viewer.id);
      } catch {
        setError(NOT_SAVED);
        return;
      }
      setConfirming(false);
      onDone(result.ok ? { text: `${viewer.email}: ${result.message}`, tone: "ok" } : { text: result.error, tone: "bad" });
    });
  };
  const cancel = () => {
    focusRemoveNext.current = true;
    setConfirming(false);
  };

  return (
    <li aria-busy={pending}>
      <div className="admin-people-who">
        <span className="admin-people-email">{viewer.email}</span>
        <span className="admin-field-hint">Added {viewer.added}</span>
      </div>
      {confirming ? (
        <div className="admin-confirm admin-confirm-danger" role="group" aria-labelledby={questionId}>
          <p id={questionId}>Remove {viewer.email}? They won&apos;t be able to open the admin.</p>
          <div className="admin-flag-actions">
            <button type="button" className="admin-flag-btn admin-flag-btn-danger" disabled={pending} onClick={remove}>
              {pending ? "Removing…" : "Yes, remove"}
            </button>
            <button ref={cancelButton} type="button" className="admin-flag-btn" disabled={pending} onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button ref={removeButton} type="button" className="admin-linkbtn" aria-label={`Remove ${viewer.email}`} onClick={() => setConfirming(true)}>
          Remove
        </button>
      )}
      {error && (
        <p className="admin-flag-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
