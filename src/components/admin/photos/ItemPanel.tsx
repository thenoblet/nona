"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent, type RefObject } from "react";
import { placeholderUrl } from "@/components/album/placeholder";
import {
  deleteMediaAction,
  hideMediaAction,
  moveMediaAction,
  retryProcessingAction,
  setHighlightAction,
  unhideMediaAction,
  type MediaActionResult,
} from "@/app/admin/photos/actions";
import {
  badgeOf,
  failureReasonWords,
  fileWords,
  lockWords,
  longTimeWords,
  statusWords,
  uploadsWords,
  type AdminItem,
} from "@/lib/media/admin-item";
import { clockTime, type AlbumCelebration } from "@/lib/media/album-item";
import { AdminIcon } from "./AdminIcon";

const NOT_DONE = "That didn't work. Check the connection, reload the page and try again.";

export type CelebrationOption = { id: AlbumCelebration; name: string };

/** What Undo puts back after the last action. */
type Undo = { kind: "hide" } | { kind: "unhide" } | { kind: "move"; celebration: AlbumCelebration };
type Notice = { text: string; tone: "ok" | "bad"; undo?: Undo };

/** The preview: the viewing size while guests can see it; the ThumbHash once its files are withdrawn (Ruling BV). */
function Preview({ item }: { item: AdminItem }) {
  const blur = useRef<HTMLSpanElement>(null);
  const image = item.view ?? item.thumb;
  useEffect(() => {
    if (image || !item.thumbhash || !blur.current) return;
    const url = placeholderUrl(item.thumbhash);
    if (url) blur.current.style.backgroundImage = `url(${url})`;
  }, [image, item.thumbhash]);
  return (
    <div className="admin-preview">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- guest media never goes through Next's image optimiser
        <img src={image} alt={`${item.kind === "video" ? "Video" : "Photo"} from ${item.by ?? "a guest"}`} />
      ) : item.thumbhash ? (
        <span ref={blur} className="admin-preview-blur" style={item.color ? { backgroundColor: item.color } : undefined} />
      ) : (
        <span className="admin-nothumb">
          <AdminIcon name="alert" size={28} />
        </span>
      )}
      {/* A 15-minute link to the original, through the couple's own route (Ruling BV). */}
      <a className="admin-preview-open" href={`/admin/photos/original/${item.id}`} target="_blank" rel="noopener noreferrer">
        <AdminIcon name="open" size={14} />
        {/* A HEIC, or a file the worker refused, downloads rather than opening (the route says so too). */}
        {item.original.heic || item.failure?.during === "processing" ? "Download original" : "Open original"}
      </a>
    </div>
  );
}

/**
 * The selected item's panel (gate B): what it is, what guests see of it, and everything the couple
 * can do with it. Hide needs no confirm (Undo and Unhide reverse it); Delete permanently is greyed
 * until the original's 30-day lock has passed, then asks first. A side panel on a laptop, a sheet
 * from the bottom on a phone (AlbumBrowser places it).
 */
export function ItemPanel({
  item,
  celebrations,
  closeButton,
  onClose,
  onChanged,
}: {
  item: AdminItem;
  celebrations: CelebrationOption[];
  closeButton: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** The item as an action left it; null once deleted. */
  onChanged: (mediaId: string, item: AdminItem | null) => void;
}) {
  const headingId = useId();
  const moveId = useId();
  const lockId = useId();
  const confirmId = useId();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, startAction] = useTransition();
  const [moveTo, setMoveTo] = useState<AlbumCelebration>(item.celebration);
  const noticeRef = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const focusDelete = useRef(false);

  const kindWord = item.kind === "video" ? "video" : "photo";
  const celebrationName = (id: AlbumCelebration) => celebrations.find((celebration) => celebration.id === id)?.name ?? id;

  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (focusDelete.current) deleteButton.current?.focus();
    focusDelete.current = false;
  }, [confirming]);

  /** Runs an action, shows what it did, and hands the item as it now is to the page. */
  function run(action: () => Promise<MediaActionResult>, done: (item: AdminItem | null) => Notice) {
    startAction(async () => {
      let result: MediaActionResult;
      try {
        result = await action();
      } catch {
        result = { ok: false, error: NOT_DONE };
      }
      setConfirming(false);
      if (result.ok) {
        onChanged(item.id, result.item);
        if (result.item) setMoveTo(result.item.celebration);
        setNotice(done(result.item));
      } else {
        setNotice({ text: result.error, tone: "bad" });
      }
      requestAnimationFrame(() => noticeRef.current?.focus({ preventScroll: true }));
    });
  }

  function hide() {
    run(() => hideMediaAction(item.id), () => ({ text: "Hidden. Guests can no longer see it.", tone: "ok", undo: { kind: "unhide" } }));
  }

  function unhide() {
    run(
      () => unhideMediaAction(item.id),
      () => ({ text: "Back in the album. Guests see it again once its thumbnail is made, in a moment.", tone: "ok", undo: { kind: "hide" } }),
    );
  }

  function move() {
    const from = item.celebration;
    run(
      () => moveMediaAction(item.id, moveTo),
      (moved) => ({ text: `Moved to ${celebrationName(moved?.celebration ?? moveTo)}.`, tone: "ok", undo: { kind: "move", celebration: from } }),
    );
  }

  function undo(previous: Undo) {
    if (previous.kind === "unhide") {
      // Undo is an unhide: its files are made again, so guests see it once they are.
      run(
        () => unhideMediaAction(item.id),
        () => ({ text: "Undone. Back in the album: guests see it again once its thumbnail is made, in a moment.", tone: "ok" }),
      );
    } else if (previous.kind === "hide") {
      run(() => hideMediaAction(item.id), () => ({ text: "Undone. It's hidden again.", tone: "ok" }));
    } else {
      run(() => moveMediaAction(item.id, previous.celebration), () => ({ text: "Undone.", tone: "ok" }));
    }
  }

  function highlight() {
    const on = !item.highlight;
    run(
      () => setHighlightAction(item.id, on),
      () => ({
        text: on ? (item.kind === "video" ? "Highlighted. It moves to the front of the video queue." : "Highlighted.") : "No longer highlighted.",
        tone: "ok",
      }),
    );
  }

  function retry() {
    run(() => retryProcessingAction(item.id), () => ({ text: "Sent back to the worker. This usually takes under a minute.", tone: "ok" }));
  }

  function deleteForGood() {
    run(() => deleteMediaAction(item.id), () => ({ text: "Deleted permanently. The original and every copy are gone.", tone: "ok" }));
  }

  function escapeConfirm(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    event.stopPropagation();
    focusDelete.current = true;
    setConfirming(false);
  }

  const badge = badgeOf(item) ?? { tone: "ok" as const, panel: "In the album", tile: "" };
  const removedByGuest = item.state === "removed";
  const withdrawn = removedByGuest || item.state === "hidden";

  return (
    <>
      <div className="admin-panel-head">
        <h2 id={headingId}>
          {item.kind === "video" ? "Video" : "Photo"} from {item.by ?? "a guest"}
        </h2>
        <button ref={closeButton} type="button" className="admin-iconbtn" aria-label="Close" onClick={onClose}>
          <AdminIcon name="close" size={20} />
        </button>
      </div>
      <Preview item={item} />
      <div className="admin-panel-body" aria-busy={busy}>
        {notice ? (
          <div
            ref={noticeRef}
            tabIndex={-1}
            className={`admin-notice admin-notice-row${notice.tone === "bad" ? " admin-notice-bad" : ""}`}
            role="status"
          >
            <span>{notice.text}</span>
            {notice.undo ? (
              <button type="button" className="admin-linkbtn" disabled={busy} onClick={() => undo(notice.undo!)}>
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
        <p className="admin-status-line">
          <span className={`admin-badge admin-badge-${badge.tone}`}>{badge.panel}</span>
          <span>{statusWords(item)}</span>
        </p>
        {item.failure ? (
          <p className="admin-reason">
            {failureReasonWords(item.failure, item.kind)}
            <small>
              {item.failure.during === "conversion" ? "Conversion" : "Worker"}: {item.failure.reason ?? "processing-failed"}
            </small>
          </p>
        ) : null}
        <dl className="admin-facts">
          <dt>Shared by</dt>
          <dd>
            {item.by ?? "A guest"} {item.uploads !== null ? <span>({uploadsWords(item.uploads)})</span> : null}
          </dd>
          {item.takenAt ? (
            <>
              <dt>Taken</dt>
              <dd>{longTimeWords(item.takenAt)}</dd>
            </>
          ) : null}
          <dt>Uploaded</dt>
          <dd>{longTimeWords(item.uploadedAt)}</dd>
          <dt>File</dt>
          <dd>
            {fileWords(item)}
            {item.seconds !== null ? ` · ${clockTime(item.seconds)}` : ""}
          </dd>
        </dl>
        <div className="admin-actions">
          {item.failure ? (
            <div className="admin-action">
              <button type="button" className="admin-btn admin-btn-primary" disabled={busy} onClick={retry}>
                <AdminIcon name="retry" />
                Retry processing
              </button>
              <span className="admin-field-hint">Runs it through the worker again. Most failures need the guest to send it again.</span>
            </div>
          ) : null}
          <div className="admin-action">
            {withdrawn ? (
              <>
                <button type="button" className={`admin-btn${item.failure ? "" : " admin-btn-primary"}`} disabled={busy} onClick={unhide}>
                  <AdminIcon name="eye" />
                  Unhide
                </button>
                <span className="admin-field-hint">
                  {removedByGuest
                    ? `${item.by ?? "The guest"} removed this themselves. Bring it back only if they ask.`
                    : "Puts it back in the album for everyone."}
                </span>
              </>
            ) : (
              <>
                <button type="button" className="admin-btn" disabled={busy} onClick={hide}>
                  <AdminIcon name="eye-off" />
                  Hide from the album
                </button>
                <span className="admin-field-hint">Guests stop seeing it at once, the TV too. You can unhide it.</span>
              </>
            )}
          </div>
          <div className="admin-action">
            <label className="admin-label" htmlFor={moveId}>
              Celebration
            </label>
            <div className="admin-move">
              <select id={moveId} value={moveTo} disabled={busy} onChange={(event) => setMoveTo(event.target.value as AlbumCelebration)}>
                {celebrations.map((celebration) => (
                  <option key={celebration.id} value={celebration.id}>
                    {celebration.name}
                  </option>
                ))}
              </select>
              <button type="button" className="admin-btn" disabled={busy || moveTo === item.celebration} onClick={move}>
                Move
              </button>
            </div>
          </div>
          <div className="admin-action">
            <button type="button" className="admin-btn" aria-pressed={item.highlight} disabled={busy} onClick={highlight}>
              <AdminIcon name={item.highlight ? "star-fill" : "star"} />
              {item.highlight ? "Highlighted" : "Highlight"}
            </button>
            <span className="admin-field-hint">
              {item.kind === "video" ? "A star for your favourites. Highlighted videos are converted first." : "A star for your favourites."}
            </span>
          </div>
          <div className="admin-action">
            {confirming ? (
              <div className="admin-confirm" role="group" aria-labelledby={confirmId} onKeyDown={escapeConfirm}>
                <p id={confirmId}>Delete this {kindWord} permanently?</p>
                <p>The original and every copy go, and it can&apos;t be undone.</p>
                <div className="admin-confirm-actions">
                  <button type="button" className="admin-btn admin-btn-small admin-btn-danger-solid" disabled={busy} onClick={deleteForGood}>
                    {busy ? "Deleting…" : "Delete permanently"}
                  </button>
                  <button
                    ref={cancelButton}
                    type="button"
                    className="admin-btn admin-btn-small"
                    disabled={busy}
                    onClick={() => {
                      focusDelete.current = true;
                      setConfirming(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <button
                  ref={deleteButton}
                  type="button"
                  className="admin-btn admin-btn-danger"
                  disabled={busy || !item.deletable}
                  aria-describedby={lockId}
                  onClick={() => {
                    setNotice(null);
                    setConfirming(true);
                  }}
                >
                  <AdminIcon name={item.deletable ? "trash" : "lock"} />
                  Delete permanently
                </button>
                <span className="admin-field-hint" id={lockId}>
                  {item.deletable
                    ? "Removes the original and every copy. Uploaded more than 30 days ago, so it's no longer locked."
                    : `Can be deleted permanently from ${lockWords(item.deletableFrom)}. Originals are locked for 30 days; hide it if it has to go now.`}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** The panel with nothing chosen yet (on a laptop). */
export function EmptyPanel() {
  return (
    <>
      <div className="admin-panel-head">
        <h2>Nothing chosen</h2>
      </div>
      <p className="admin-panel-empty">Choose a photo or video to see what you can do with it.</p>
    </>
  );
}

/** The panel once its item is deleted for good. */
export function DeletedPanel({ closeButton, onClose }: { closeButton: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const notice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    notice.current?.focus({ preventScroll: true });
  }, []);
  return (
    <>
      <div className="admin-panel-head">
        <h2>Deleted</h2>
        <button ref={closeButton} type="button" className="admin-iconbtn" aria-label="Close" onClick={onClose}>
          <AdminIcon name="close" size={20} />
        </button>
      </div>
      <div className="admin-panel-body">
        <p ref={notice} className="admin-notice" role="status" tabIndex={-1}>
          Deleted permanently. The original and every copy are gone.
        </p>
      </div>
    </>
  );
}
