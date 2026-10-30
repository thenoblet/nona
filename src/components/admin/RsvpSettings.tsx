"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { closeRsvpsAction, reopenRsvpsAction, saveRsvpSettingsAction } from "@/app/admin/rsvps/actions";
import { wedding } from "@/content/wedding";
import { parseIssues, type SaveState } from "@/lib/admin/content";

const NOT_SAVED = "That didn't save. Check the connection, reload the page and try again.";
const DAY_MS = 24 * 60 * 60 * 1000;
/** The last day the date picker offers: the day before the wedding. */
const lastReplyBy = new Date(Date.parse(wedding.weekendStart) - DAY_MS).toISOString().slice(0, 10);

type Notice = { text: string; tone: "ok" | "bad" };
type FieldErrors = { replyBy?: string; closedMessage?: string };
type Draft = { replyBy: FormDataEntryValue | null; closedMessage: FormDataEntryValue | null };

/**
 * The RSVP switch, the reply-by date and the closed message. Closing and reopening ask first,
 * saying what guests will see. Each change carries the version the page showed, so a change saved
 * since (by the other of the couple, or in another tab) is never overwritten unseen. The switch
 * uses the saved date and message, so it waits while either has unsaved edits.
 */
export function RsvpSettings({
  open,
  replyBy,
  replyByLabel,
  closedMessage,
  version,
  closedSince,
}: {
  open: boolean;
  /** "2026-11-20", and as guests read it, "20 November". */
  replyBy: string;
  replyByLabel: string;
  closedMessage: string;
  version: number;
  /** "30 Oct, 21:14 by nancy@example.com", from the version that closed replies. */
  closedSince: string | null;
}) {
  const headingId = useId();
  const questionId = useId();
  const unsavedHintId = useId();
  const dateId = useId();
  const messageId = useId();
  const [confirming, setConfirming] = useState(false);
  const [switching, startSwitching] = useTransition();
  const [switchNotice, setSwitchNotice] = useState<Notice | null>(null);
  const [saving, startSaving] = useTransition();
  const [saveNotice, setSaveNotice] = useState<Notice | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  // What the boxes hold after the last edit; null until one, and again after an undo.
  const [draft, setDraft] = useState<Draft | null>(null);
  const unsaved = draft !== null && (draft.replyBy !== replyBy || draft.closedMessage !== closedMessage);
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const switchButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const focusSwitchButton = useRef(false);

  // The confirm opens on its safe choice. Once it closes, focus goes back to the switch, or to the
  // heading while the switch waits for unsaved edits (a disabled button can't take focus).
  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (focusSwitchButton.current) {
      const target = switchButton.current;
      if (target && !target.disabled) target.focus();
      else heading.current?.focus();
    }
    focusSwitchButton.current = false;
  }, [confirming]);

  function cancel() {
    focusSwitchButton.current = true;
    setConfirming(false);
  }

  /** Escape cancels the confirm, like Cancel, unless the switch is already under way. */
  function escape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || switching) return;
    event.preventDefault();
    cancel();
  }

  function switchReplies() {
    startSwitching(async () => {
      let result: SaveState;
      try {
        result = open ? await closeRsvpsAction(version) : await reopenRsvpsAction(version);
      } catch {
        result = { status: "error", errors: [NOT_SAVED] };
      }
      focusSwitchButton.current = true;
      setConfirming(false);
      setSwitchNotice(
        result.status === "saved"
          ? { text: open ? "RSVPs are closed. Guests see the closed message now." : "RSVPs are open again. Guests see the form now.", tone: "ok" }
          : { text: result.errors[0] ?? NOT_SAVED, tone: "bad" },
      );
    });
  }

  function edited(event: FormEvent<HTMLFormElement>) {
    const data = new FormData(event.currentTarget);
    setDraft({ replyBy: data.get("replyBy"), closedMessage: data.get("closedMessage") });
  }

  function undo() {
    // Back to the saved date and message: React keeps each box's default at the saved value.
    form.current?.reset();
    setDraft(null);
    setFieldErrors({});
    setSaveNotice(null);
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const data = new FormData(event.currentTarget);
    startSaving(async () => {
      let result: SaveState;
      try {
        result = await saveRsvpSettingsAction(data);
      } catch {
        result = { status: "error", errors: [NOT_SAVED] };
      }
      const errors: FieldErrors = {};
      let message: string | null = null;
      for (const issue of parseIssues("rsvp", result.errors)) {
        if (issue.path === "replyBy" || issue.path === "closedMessage") errors[issue.path] ??= issue.message;
        else message ??= issue.message;
      }
      setFieldErrors(errors);
      // Saved: the boxes now hold the saved text (the save trims the message's ends).
      if (result.status === "saved") setDraft(null);
      setSaveNotice(
        result.status === "saved"
          ? { text: "Saved. Guests see it now.", tone: "ok" }
          : { text: message ?? "Check the date and the message.", tone: "bad" },
      );
    });
  }

  return (
    <section className="admin-rsvp" aria-labelledby={headingId}>
      <h2 ref={heading} id={headingId} tabIndex={-1}>
        RSVP settings
      </h2>
      <div className="admin-rsvp-switch">
        <p className="admin-rsvp-state">
          {open ? (
            <span className="admin-badge admin-badge-ok">Open</span>
          ) : (
            <>
              <span className="admin-badge admin-badge-bad">Closed</span>
              {closedSince ? ` since ${closedSince}` : null}
            </>
          )}
        </p>
        {confirming ? null : (
          <button
            ref={switchButton}
            type="button"
            className="admin-btn"
            disabled={unsaved}
            aria-describedby={unsaved ? unsavedHintId : undefined}
            onClick={() => setConfirming(true)}
          >
            {open ? "Close RSVPs" : "Reopen RSVPs"}
          </button>
        )}
      </div>
      {unsaved && (
        <p id={unsavedHintId} className="admin-rsvp-hint">
          Save or undo your changes first
        </p>
      )}
      {confirming && (
        <div className="admin-confirm" role="group" aria-labelledby={questionId} onKeyDown={escape}>
          <p id={questionId}>
            {open
              ? `Close RSVPs? The RSVP page will show guests “${closedMessage}” instead of the form, the home page and the invitation will say “Replies have closed”, and a reply sent from a page opened earlier is refused.`
              : `Reopen RSVPs? Guests will see the reply form again, asking them to reply by ${replyByLabel}.`}
          </p>
          <div className="admin-confirm-actions">
            <button
              type="button"
              className="admin-btn admin-btn-small admin-btn-primary"
              disabled={switching || unsaved}
              aria-describedby={unsaved ? unsavedHintId : undefined}
              onClick={switchReplies}
            >
              {switching ? (open ? "Closing…" : "Reopening…") : open ? "Yes, close RSVPs" : "Yes, reopen RSVPs"}
            </button>
            <button
              ref={cancelButton}
              type="button"
              className="admin-btn admin-btn-small"
              disabled={switching}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className={`admin-notice admin-rsvp-notice${switchNotice?.tone === "bad" ? " admin-notice-bad" : ""}`} role="status">
        {switchNotice?.text}
      </p>

      <form ref={form} className="admin-rsvp-form" onChange={edited} onSubmit={save} aria-busy={saving} noValidate>
        <input type="hidden" name="baseVersion" value={version} />
        <div className={`admin-field${fieldErrors.replyBy ? " admin-field-invalid" : ""}`}>
          <label htmlFor={dateId}>Reply by</label>
          <input
            id={dateId}
            name="replyBy"
            type="date"
            defaultValue={replyBy}
            max={lastReplyBy}
            required
            aria-invalid={fieldErrors.replyBy ? true : undefined}
            aria-describedby={fieldErrors.replyBy ? `${dateId}-error` : undefined}
          />
          {fieldErrors.replyBy && (
            <span id={`${dateId}-error`} className="admin-field-error">
              {fieldErrors.replyBy}
            </span>
          )}
        </div>
        <div className={`admin-field${fieldErrors.closedMessage ? " admin-field-invalid" : ""}`}>
          <label htmlFor={messageId}>Message while closed</label>
          <textarea
            id={messageId}
            name="closedMessage"
            defaultValue={closedMessage}
            maxLength={300}
            required
            aria-invalid={fieldErrors.closedMessage ? true : undefined}
            aria-describedby={`${messageId}-hint${fieldErrors.closedMessage ? ` ${messageId}-error` : ""}`}
          />
          <span id={`${messageId}-hint`} className="admin-field-hint">
            Shown on the RSVP page instead of the form while RSVPs are closed. Up to 300 characters.
          </span>
          {fieldErrors.closedMessage && (
            <span id={`${messageId}-error`} className="admin-field-error">
              {fieldErrors.closedMessage}
            </span>
          )}
        </div>
        <div className="admin-rsvp-save">
          <span className={`admin-savestatus admin-savestatus-${saveNotice?.tone ?? "muted"}`} role="status">
            {saveNotice?.text}
          </span>
          <div className="admin-rsvp-save-actions">
            {unsaved && (
              <button type="button" className="admin-btn" onClick={undo}>
                Undo changes
              </button>
            )}
            <button type="submit" className="admin-btn admin-btn-primary" aria-disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
