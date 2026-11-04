"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { restoreSlotAction, saveSlotAction, slotStateAction, type SlotActionResult } from "@/app/admin/photos/site/actions";
import type { EditorPhoto, SlotView } from "@/lib/site-images/admin";
import { clampFraction, objectPosition, type Focal } from "@/lib/site-images/focal";
import { AdminIcon } from "@/components/admin/photos/AdminIcon";
import { SiteUploadError, uploadSitePhoto, waitUntilReady } from "./site-upload";

/*
 * One site photo slot (gate B): its row (the photo, its name, where it shows, its state, and Edit
 * and Replace), and under it the editor: a tap-to-set focal point, the alt text (required to save),
 * how the photo crops, a preview slot's drawn card with WhatsApp's crop lines, Save, and the
 * earlier photos to go back to.
 */

type Tone = "ok" | "bad" | "muted";
type Status = { text: string; tone: Tone } | null;
/** A photo just uploaded and made ready, not on the site until saved. */
type Pending = { mediaId: string; photo: EditorPhoto };
type Upload = { phase: "sending" | "preparing"; fraction: number } | null;

const SAVED_NOTE = "Saved. The site shows it within a few seconds.";
const DRAWING_NOTE = "Saved. Drawing the new card…";
const CACHE_NOTE = "Saved. Links shared from now on show the new card; WhatsApp may keep the old one on links already sent.";
const CARD_POLL_MILLISECONDS = 2_000;
/** About two minutes of asking; a card takes a few seconds once the worker has it. */
const CARD_POLL_LIMIT = 60;
const PHOTO_ACCEPT = "image/*,.heic,.heif";

const statusClass: Record<Tone, string> = { ok: "admin-savestatus-ok", bad: "admin-savestatus-bad", muted: "admin-savestatus-muted" };

/** The admin's crop previews: the site's usual shapes, the oval portrait, or the card and WhatsApp's square. */
function cropsOf(shape: SlotView["shape"]): { label: string; width: number; height: number; radius: string }[] {
  if (shape === "oval") return [{ label: "Portrait", width: 60, height: 80, radius: "50%" }];
  if (shape === "card") {
    return [
      { label: "Card", width: 120, height: 63, radius: "4px" },
      { label: "WhatsApp", width: 63, height: 63, radius: "4px" },
    ];
  }
  return [
    { label: "Phone", width: 45, height: 80, radius: "4px" },
    { label: "Wide", width: 128, height: 72, radius: "4px" },
    { label: "Square", width: 72, height: 72, radius: "4px" },
  ];
}

function focalLabel(focal: Focal): string {
  return `Focal point, ${Math.round(focal.x * 100)}% across and ${Math.round(focal.y * 100)}% down. Tap the photo, or use the arrow keys to move it.`;
}

export function SlotCard({ initial, onDirtyChange }: { initial: SlotView; onDirtyChange: (slotId: string, dirty: boolean) => void }) {
  const [view, setView] = useState(initial);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [alt, setAlt] = useState(initial.alt);
  const [focal, setFocal] = useState(initial.focal);
  const [dirty, setDirty] = useState(false);
  const [altError, setAltError] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [saving, setSaving] = useState(false);
  const [upload, setUpload] = useState<Upload>(null);
  const [drawing, setDrawing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const altField = useRef<HTMLTextAreaElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  const altId = useId();
  const altErrorId = useId();
  const photo = pending?.photo ?? view.photo;
  const hasPhoto = photo !== null;

  useEffect(() => onDirtyChange(view.id, dirty), [dirty, view.id, onDirtyChange]);
  useEffect(() => () => uploadAbort.current?.abort(), []);

  // While the worker draws a preview card: ask every 2 s until it is drawn, then show it and WhatsApp's cache note.
  useEffect(() => {
    if (!drawing) return;
    let asked = 0;
    let stopped = false;
    const knownCardUrl = view.card?.drawn ? view.card.url : null;
    const timer = setInterval(async () => {
      asked += 1;
      if (stopped) return;
      let result: SlotActionResult;
      try {
        result = await slotStateAction(view.id, knownCardUrl);
      } catch {
        return;
      }
      if (stopped || !result.ok) return;
      if (result.slot.card?.drawn) {
        stopped = true;
        clearInterval(timer);
        setView(result.slot);
        setDrawing(false);
        setStatus({ text: CACHE_NOTE, tone: "ok" });
      } else if (asked >= CARD_POLL_LIMIT) {
        stopped = true;
        clearInterval(timer);
        setDrawing(false);
        setStatus({ text: "Saved. The new card is still being drawn; reload this page in a minute to see it.", tone: "muted" });
      }
    }, CARD_POLL_MILLISECONDS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // Started once per save; the view it read the card from is the one the save returned.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing]);

  function markDirty() {
    setDirty(true);
    setStatus({ text: "Not saved yet.", tone: "muted" });
  }

  function placeFocal(next: Focal) {
    setFocal({ x: clampFraction(next.x), y: clampFraction(next.y) });
    markDirty();
  }

  function focalFromPointer(event: PointerEvent<HTMLButtonElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    placeFocal({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  }

  function onFocalKey(event: KeyboardEvent<HTMLButtonElement>) {
    const steps: Record<string, [number, number]> = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    placeFocal({ x: focal.x + step[0], y: focal.y + step[1] });
  }

  async function onFileChosen(file: File | undefined) {
    if (!file) return;
    uploadAbort.current?.abort();
    const controller = new AbortController();
    uploadAbort.current = controller;
    setStatus(null);
    setUpload({ phase: "sending", fraction: 0 });
    try {
      const mediaId = await uploadSitePhoto(file, {
        signal: controller.signal,
        onProgress: (fraction) => setUpload({ phase: "sending", fraction }),
      });
      setUpload({ phase: "preparing", fraction: 1 });
      const ready = await waitUntilReady(mediaId, { signal: controller.signal });
      setPending({ mediaId, photo: ready });
      setAlt("");
      setFocal({ x: 0.5, y: 0.5 });
      setAltError(false);
      setDirty(true);
      setOpen(true);
      setStatus({ text: "New photo. Add alt text, set the focal point, then save.", tone: "muted" });
      requestAnimationFrame(() => altField.current?.focus());
    } catch (error) {
      if (controller.signal.aborted) return;
      setStatus({ text: error instanceof SiteUploadError ? error.message : "That photo couldn't be sent. Try again.", tone: "bad" });
      setOpen(hasPhoto);
    } finally {
      if (uploadAbort.current === controller) setUpload(null);
    }
  }

  function applied(result: SlotActionResult, note: string): boolean {
    if (!result.ok) {
      if (result.field === "alt") {
        setAltError(true);
        altField.current?.focus();
      }
      setStatus({ text: result.error, tone: "bad" });
      return false;
    }
    setView(result.slot);
    setPending(null);
    setAlt(result.slot.alt);
    setFocal(result.slot.focal);
    setDirty(false);
    setAltError(false);
    if (result.slot.card && !result.slot.card.drawn) {
      setDrawing(true);
      setStatus({ text: DRAWING_NOTE, tone: "ok" });
    } else {
      setStatus({ text: result.slot.card ? CACHE_NOTE : note, tone: "ok" });
    }
    return true;
  }

  async function save() {
    if (!alt.trim()) {
      setAltError(true);
      setStatus({ text: "Add alt text first.", tone: "bad" });
      altField.current?.focus();
      return;
    }
    setSaving(true);
    try {
      applied(await saveSlotAction({ slot: view.id, mediaId: pending ? pending.mediaId : view.mediaId, alt, focal }), SAVED_NOTE);
    } catch {
      setStatus({ text: "That didn't save. Check your connection and try again.", tone: "bad" });
    } finally {
      setSaving(false);
    }
  }

  async function restore(version: string) {
    setSaving(true);
    try {
      applied(await restoreSlotAction(view.id, version), "Restored. The site shows it within a few seconds.");
    } catch {
      setStatus({ text: "That didn't work. Check your connection and try again.", tone: "bad" });
    } finally {
      setSaving(false);
    }
  }

  const shape = view.shape === "oval" ? "is-oval" : view.shape === "card" ? "is-card" : "";
  const editorOpen = open && hasPhoto;
  const ratio = photo ? photo.width / photo.height : 1;
  const focalWidth = Math.round(Math.min(300, 340 * ratio));
  const position = objectPosition(focal);
  const stateLine = pending ? (
    <>
      <span className="admin-badge admin-badge-wait">Not saved</span>New photo, not on the site yet
    </>
  ) : view.state === "yours" ? (
    <>
      <span className="admin-badge admin-badge-ok">Your photo</span>Saved {view.savedAt} by {view.savedBy}
    </>
  ) : view.state === "builtin" ? (
    <>
      <span className="admin-badge admin-badge-none">Built-in</span>
      {view.edited ? `Built-in photo, edited ${view.savedAt}` : "Using the built-in photo"}
    </>
  ) : (
    <>
      <span className="admin-badge admin-badge-none">No photo yet</span>
      {view.shape === "oval" ? "The site shows a plain oval." : "The site shows its plain colour."}
    </>
  );

  return (
    <article className="admin-slot" data-open={editorOpen ? "" : undefined} aria-labelledby={`${altId}-name`}>
      <div className="admin-slot-row">
        <span className={`admin-slot-thumb ${shape}`}>
          {view.card && !pending ? (
            // eslint-disable-next-line @next/next/no-img-element -- the drawn card, as it is
            <img src={view.card.url} alt="" loading="lazy" decoding="async" />
          ) : photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a thumbnail of its own (the worker's, or a built-in's)
            <img src={photo.thumbUrl} alt="" loading="lazy" decoding="async" style={{ objectPosition: position }} />
          ) : (
            <span className="admin-nophoto">
              <AdminIcon name="user" size={22} />
            </span>
          )}
        </span>
        <div className="admin-slot-text">
          <h3 id={`${altId}-name`}>{view.name}</h3>
          <p className="admin-slot-where">{view.where}</p>
          <p className="admin-slot-state">{stateLine}</p>
        </div>
        {upload ? (
          <div className="admin-progress" role="status">
            <span>{upload.phase === "sending" ? `Uploading ${Math.round(upload.fraction * 100)}%` : "Getting it ready…"}</span>
            <span className="admin-progress-track">
              <span className="admin-progress-fill" style={{ width: `${Math.round(upload.fraction * 100)}%` }} />
            </span>
          </div>
        ) : (
          <div className="admin-slot-buttons">
            {hasPhoto ? (
              <button
                ref={toggleButton}
                type="button"
                className="admin-btn admin-btn-small"
                aria-expanded={editorOpen}
                aria-label={`Edit ${view.name}`}
                onClick={() => setOpen(!open)}
              >
                Edit <AdminIcon name="chevron" size={14} />
              </button>
            ) : null}
            <button
              type="button"
              className="admin-btn admin-btn-small"
              aria-label={`${hasPhoto ? "Replace" : "Add a photo for"} ${view.name}`}
              onClick={() => fileInput.current?.click()}
            >
              <AdminIcon name="upload" size={14} />
              {hasPhoto ? "Replace" : "Add photo"}
            </button>
            <input
              ref={fileInput}
              className="admin-filepick"
              type="file"
              accept={PHOTO_ACCEPT}
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                void onFileChosen(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
          </div>
        )}
      </div>
      {!editorOpen && status ? (
        <p className={`admin-savestatus admin-slot-status ${statusClass[status.tone]}`} role="status">
          {status.text}
        </p>
      ) : null}

      {editorOpen && photo ? (
        <div className="admin-slot-editor">
          <div className="admin-focal-wrap">
            <button
              type="button"
              className={`admin-focal${dragging ? " is-dragging" : ""}`}
              style={{ width: focalWidth, aspectRatio: ratio }}
              aria-label={focalLabel(focal)}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                setDragging(true);
                focalFromPointer(event);
              }}
              onPointerMove={(event) => {
                if (dragging) focalFromPointer(event);
              }}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              onKeyDown={onFocalKey}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- the worker's own size, never Next's optimiser */}
              <img src={photo.url} alt="" draggable={false} />
              <span className="admin-focal-dot" style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }} />
            </button>
            <p className="admin-field-hint">Tap the photo where it matters most. Every crop keeps that point in view.</p>
          </div>

          <div className="admin-slot-fields">
            <div className={`admin-field${altError ? " admin-field-invalid" : ""}`}>
              <label htmlFor={altId}>Alt text</label>
              <textarea
                ref={altField}
                id={altId}
                rows={2}
                value={alt}
                aria-invalid={altError || undefined}
                aria-describedby={altError ? altErrorId : undefined}
                onChange={(event) => {
                  setAlt(event.target.value);
                  if (event.target.value.trim()) setAltError(false);
                  markDirty();
                }}
              />
              {altError ? (
                <span className="admin-field-error" id={altErrorId}>
                  Describe the photo before saving.
                </span>
              ) : (
                <span className="admin-field-hint">{view.altHint}</span>
              )}
            </div>

            <div className="admin-field">
              <span className="admin-label">How it crops</span>
              <div className="admin-crops">
                {cropsOf(view.shape).map((crop) => (
                  <figure key={crop.label}>
                    <span className="admin-crop" style={{ width: crop.width, height: crop.height, borderRadius: crop.radius }}>
                      {/* eslint-disable-next-line @next/next/no-img-element -- a preview of the crop */}
                      <img src={photo.thumbUrl} alt="" style={{ objectPosition: position }} />
                    </span>
                    <figcaption>{crop.label}</figcaption>
                  </figure>
                ))}
              </div>
            </div>

            {view.card ? (
              <div className="admin-field">
                <span className="admin-label">Link preview</span>
                <div className="admin-card">
                  {/* eslint-disable-next-line @next/next/no-img-element -- the drawn card, as it is */}
                  <img src={view.card.url} alt={`The link preview card for ${view.name}`} />
                  <span className="admin-card-square" aria-hidden="true" />
                  {drawing ? (
                    <div className="admin-card-drawing">
                      <span className="admin-spinner" />
                      <span>Drawing the new card…</span>
                    </div>
                  ) : null}
                </div>
                <span className="admin-field-hint">Between the dashed lines is what WhatsApp shows in a chat.</span>
              </div>
            ) : null}

            <div className="admin-slot-save">
              <p className={`admin-savestatus ${statusClass[status?.tone ?? "muted"]}`} role="status">
                {status?.text ?? ""}
              </p>
              <button type="button" className="admin-btn admin-btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>

            {view.versions.length > 0 && !pending ? (
              <div className="admin-slot-earlier">
                <span className="admin-label">Earlier photos</span>
                <ul>
                  {view.versions.map((version) => (
                    <li key={version.id}>
                      <span className="admin-slot-earlier-thumb">
                        {version.photo ? (
                          // eslint-disable-next-line @next/next/no-img-element -- the worker's own size, never Next's optimiser
                          <img
                            src={version.photo.thumbUrl}
                            alt=""
                            loading="lazy"
                            decoding="async"
                            style={{ objectPosition: objectPosition(version.focal) }}
                          />
                        ) : null}
                      </span>
                      <span className="admin-slot-earlier-what">{version.label}</span>
                      <button
                        type="button"
                        className="admin-btn admin-btn-small"
                        disabled={saving}
                        aria-label={`Use this one again: ${version.label}`}
                        onClick={() => void restore(version.id)}
                      >
                        Use this one
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}
