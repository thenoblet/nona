"use client";

import { useEffect, useId, useRef } from "react";

/** One saved version, with its time already written out in Accra. */
export type VersionEntry = { version: number; savedAt: string; savedBy: string };

/** What the last restore did; the serial changes with each, so the same words twice still move focus. */
export type RestoreNotice = { text: string; tone: "ok" | "bad"; serial: number };

function isShown(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.getClientRects().length > 0;
}

/**
 * The section's versions, newest first, then the built-in text. The newest is "Live now"; any
 * other can be restored after a confirm step, which saves it again as the newest version.
 * The page draws this twice (a column on wide screens, a disclosure below the form otherwise), so
 * focus only moves within the copy that is on screen.
 */
export function VersionHistory({
  versions,
  confirming,
  restoring,
  notice,
  dirty,
  onAsk,
  onCancel,
  onRestore,
}: {
  versions: VersionEntry[];
  confirming: number | null;
  restoring: boolean;
  notice: RestoreNotice;
  dirty: boolean;
  onAsk: (version: number) => void;
  onCancel: () => void;
  onRestore: (version: number) => void;
}) {
  const questionId = useId();
  const noticeBox = useRef<HTMLParagraphElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const returnTo = useRef<number | null>(null);

  // Opening a confirm puts focus on its safe choice; Cancel returns it to that version's Restore.
  useEffect(() => {
    if (confirming !== null) {
      if (isShown(cancelButton.current)) cancelButton.current.focus();
      return;
    }
    const version = returnTo.current;
    returnTo.current = null;
    const restoreButton = list.current?.querySelector<HTMLButtonElement>(`[data-restore="${version}"]`) ?? null;
    if (version !== null && isShown(restoreButton)) restoreButton.focus();
  }, [confirming]);

  // After a restore the confirm is gone, so focus moves to what happened.
  useEffect(() => {
    if (notice.serial > 0 && isShown(noticeBox.current)) noticeBox.current.focus();
  }, [notice.serial]);

  const entries = [
    ...versions.map((entry, index) => ({
      version: entry.version,
      title: `Version ${entry.version}`,
      detail: `${entry.savedAt} · ${entry.savedBy}`,
      live: index === 0,
    })),
    { version: 0, title: "Built-in text", detail: "From the site's code", live: versions.length === 0 },
  ];

  return (
    <div className="admin-versions-body">
      <p
        ref={noticeBox}
        className={`admin-notice${notice.tone === "bad" ? " admin-notice-bad" : ""}`}
        role="status"
        tabIndex={-1}
      >
        {notice.text}
      </p>
      <ol ref={list} className="admin-version-list">
        {entries.map((entry) => (
          <li key={entry.version}>
            <span className="admin-version-what">
              {entry.title}
              <small>{entry.detail}</small>
            </span>
            {entry.live ? (
              <span className="admin-version-live">Live now</span>
            ) : confirming === entry.version ? null : (
              <button
                type="button"
                className="admin-btn admin-btn-small"
                data-restore={entry.version}
                disabled={restoring}
                aria-label={`Restore ${entry.version === 0 ? "the built-in text" : entry.title.toLowerCase()}`}
                onClick={() => onAsk(entry.version)}
              >
                Restore
              </button>
            )}
            {confirming === entry.version && (
              <div className="admin-confirm" role="group" aria-labelledby={questionId}>
                <p id={questionId}>
                  Restore {entry.version === 0 ? "the built-in text" : entry.title.toLowerCase()}? It replaces what guests
                  see now{dirty ? ", and your unsaved changes here" : ""}.
                </p>
                <div className="admin-confirm-actions">
                  <button
                    type="button"
                    className="admin-btn admin-btn-small admin-btn-primary"
                    disabled={restoring}
                    onClick={() => onRestore(entry.version)}
                  >
                    {restoring ? "Restoring…" : "Yes, restore"}
                  </button>
                  <button
                    ref={cancelButton}
                    type="button"
                    className="admin-btn admin-btn-small"
                    disabled={restoring}
                    onClick={() => {
                      returnTo.current = entry.version;
                      onCancel();
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
