"use client";

import { useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { deleteWishAction, hideWishAction, unhideWishAction, type WishActionResult } from "@/app/admin/photos/actions";
import { lockWords, longTimeWords, shortTimeWords, wishBadgeOf, type AdminWish, type AdminWishPage } from "@/lib/media/admin-item";
import { clockTime } from "@/lib/media/album-item";
import { AdminIcon } from "./AdminIcon";

const NOT_DONE = "That didn't work. Check the connection, reload the page and try again.";
const LOAD_FAILED = "That didn't load. Check the connection and try again.";
const LOAD_TIMEOUT_MILLISECONDS = 15_000;

/**
 * A voice or video wish's recording, where Task 16 plays it: today its kind and length, and its
 * original through the couple's own 15-minute link.
 */
function WishRecording({ wish }: { wish: AdminWish }) {
  if (!wish.recording) return null;
  const what = wish.kind === "video" ? "Video message" : "Voice note";
  return (
    <span className="admin-wish-recording">
      <span className="admin-wish-body">
        {what}
        {wish.recording.seconds !== null ? ` · ${clockTime(wish.recording.seconds)}` : ""}
      </span>
      <a className="admin-linkbtn" href={`/admin/photos/original/${wish.recording.mediaId}`} target="_blank" rel="noopener noreferrer">
        Open original
      </a>
    </span>
  );
}

/** One wish's row: what it says, who sent it and when, its status, and Hide or Unhide and Delete permanently. */
function WishRow({
  wish,
  onChanged,
  onNotice,
}: {
  wish: AdminWish;
  onChanged: (wishId: string, wish: AdminWish | null) => void;
  onNotice: (text: string, tone: "ok" | "bad") => void;
}) {
  const confirmId = useId();
  const lockId = useId();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, startAction] = useTransition();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const focusDelete = useRef(false);
  const badge = wishBadgeOf(wish);
  const hidden = wish.hiddenAt !== null;
  const locked = !wish.deletable;

  useEffect(() => {
    if (confirming) cancelButton.current?.focus();
    else if (focusDelete.current) deleteButton.current?.focus();
    focusDelete.current = false;
  }, [confirming]);

  function run(action: () => Promise<WishActionResult>, done: string) {
    startAction(async () => {
      let result: WishActionResult;
      try {
        result = await action();
      } catch {
        result = { ok: false, error: NOT_DONE };
      }
      setConfirming(false);
      if (result.ok) {
        setError(null);
        onChanged(wish.id, result.wish);
        onNotice(done, "ok");
      } else {
        setError(result.error);
      }
    });
  }

  function cancel() {
    focusDelete.current = true;
    setConfirming(false);
  }

  function escape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    cancel();
  }

  return (
    <tr className={hidden ? "is-hidden" : undefined} data-wish={wish.id}>
      <td className="admin-wish-cell">
        {wish.kind === "text" ? <span className="admin-wish-body">“{wish.message}”</span> : <WishRecording wish={wish} />}
        {hidden ? (
          <div className="admin-field-hint" style={{ marginTop: 4 }}>
            Hidden{wish.hiddenBy ? ` by ${wish.hiddenBy}` : ""}
            {wish.hiddenAt ? `, ${shortTimeWords(wish.hiddenAt)}` : ""}
          </div>
        ) : null}
      </td>
      <td data-label="From">
        <span className="admin-wish-who">{wish.signedAs}</span>
      </td>
      <td data-label="Sent">
        <span className="admin-wish-when">{longTimeWords(wish.createdAt)}</span>
      </td>
      <td data-label="Status">
        <span className={`admin-badge admin-badge-${badge.tone}`}>{badge.panel}</span>
      </td>
      <td className="admin-wish-actions-cell">
        <div className="admin-wish-actions" aria-busy={busy}>
          {hidden ? (
            <button
              type="button"
              className="admin-btn admin-btn-small"
              disabled={busy}
              onClick={() => run(() => unhideWishAction(wish.id), `${wish.signedAs}'s wish is back on the wall.`)}
            >
              <AdminIcon name="eye" size={14} />
              Unhide
            </button>
          ) : (
            <button
              type="button"
              className="admin-btn admin-btn-small"
              disabled={busy}
              onClick={() => run(() => hideWishAction(wish.id), `Hidden. ${wish.signedAs}'s wish is off the wall.`)}
            >
              <AdminIcon name="eye-off" size={14} />
              Hide
            </button>
          )}
          {confirming ? (
            <div className="admin-confirm" role="group" aria-labelledby={confirmId} onKeyDown={escape}>
              <p id={confirmId}>Delete this wish permanently? It can&apos;t be undone.</p>
              <div className="admin-confirm-actions">
                <button
                  type="button"
                  className="admin-btn admin-btn-small admin-btn-danger-solid"
                  disabled={busy}
                  onClick={() => run(() => deleteWishAction(wish.id), "Deleted permanently.")}
                >
                  {busy ? "Deleting…" : "Delete permanently"}
                </button>
                <button ref={cancelButton} type="button" className="admin-btn admin-btn-small" disabled={busy} onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                ref={deleteButton}
                type="button"
                className="admin-btn admin-btn-small admin-btn-danger"
                disabled={busy || locked}
                aria-describedby={locked ? lockId : undefined}
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
              >
                <AdminIcon name={locked ? "lock" : "trash"} size={14} />
                Delete permanently
              </button>
              {locked && wish.deletableFrom ? (
                <span className="admin-field-hint" id={lockId}>
                  Can be deleted permanently from {lockWords(wish.deletableFrom)}
                </span>
              ) : null}
            </>
          )}
          {error ? (
            <p className="admin-wish-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </td>
    </tr>
  );
}

/**
 * The Wishes tab (gate B): a table on wide screens, a card per wish on phones. Hide and Unhide work
 * at once; Delete permanently asks first. A written wish can be deleted now; a recorded one is
 * locked for 30 days like the album's originals.
 */
export function WishesTable({ initialPage }: { initialPage: AdminWishPage }) {
  const [wishes, setWishes] = useState<AdminWish[]>(initialPage.wishes);
  const [nextCursor, setNextCursor] = useState<string | null>(initialPage.nextCursor);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [loading, setLoading] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement>(null);

  function changed(wishId: string, wish: AdminWish | null) {
    setWishes((shown) => (wish ? shown.map((candidate) => (candidate.id === wishId ? wish : candidate)) : shown.filter((candidate) => candidate.id !== wishId)));
  }

  function say(text: string, tone: "ok" | "bad") {
    setNotice({ text, tone });
    requestAnimationFrame(() => noticeRef.current?.focus({ preventScroll: true }));
  }

  async function showMore() {
    if (!nextCursor || loading) return;
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MILLISECONDS);
    try {
      const response = await fetch(`/admin/photos/wishes/items?cursor=${encodeURIComponent(nextCursor)}`, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`The wishes answered ${response.status}`);
      const page = (await response.json()) as AdminWishPage;
      setWishes((shown) => {
        const known = new Set(shown.map((wish) => wish.id));
        return [...shown, ...page.wishes.filter((wish) => !known.has(wish.id))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      say(LOAD_FAILED, "bad");
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  return (
    <div>
      <p ref={noticeRef} className={`admin-notice${notice?.tone === "bad" ? " admin-notice-bad" : ""}`} role="status" tabIndex={-1}>
        {notice?.text}
      </p>
      {wishes.length === 0 ? (
        <p className="admin-empty">No wishes yet.</p>
      ) : (
        <div className="admin-tablewrap">
          <table className="admin-wishes">
            <thead>
              <tr>
                <th scope="col">Wish</th>
                <th scope="col">From</th>
                <th scope="col">Sent</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="admin-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {wishes.map((wish) => (
                <WishRow key={wish.id} wish={wish} onChanged={changed} onNotice={say} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {nextCursor ? (
        <div className="admin-more">
          <button type="button" className="admin-btn" aria-disabled={loading} onClick={showMore}>
            {loading ? "Loading…" : "Show more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
