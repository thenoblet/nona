"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { isBusy, UPLOAD_WORDS, type UploadItem, type UploadStatus, type UploadView } from "./uploader/state";

/*
 * The cards under the album's header while a guest shares (gate A): the camera card for one shot,
 * and the gallery batch, a row for each file. Every word and state comes from the uploader's
 * store; only the server's answer to a complete ever turns a file to Added.
 *
 * Every × names its file ("Cancel photo 3", "Dismiss video"): Cancel while a file is on its way,
 * Dismiss once it has failed. Each carries data-item-action, and Try again data-item-retry, so the
 * album can move focus to the next sensible place once one of them takes a row away.
 */

const CAMERA_CAPTIONS: Partial<Record<UploadStatus, string>> = {
  queued: "Keep this page open for a moment",
  sending: "Keep this page open for a moment",
  retrying: UPLOAD_WORDS.retrying,
  confirming: "Checking it arrived safely",
  added: "Everyone will see it shortly",
};

const ROW_WORDS: Record<Exclude<UploadStatus, "failed" | "cancelling">, string> = {
  queued: UPLOAD_WORDS.waiting,
  sending: UPLOAD_WORDS.sending,
  confirming: UPLOAD_WORDS.sending,
  retrying: UPLOAD_WORDS.retrying,
  added: UPLOAD_WORDS.added,
};

/**
 * A word that changes in place: the old one lifts away as the new one rises. With `animate` off
 * (a percentage ticking up) it just changes.
 */
export function MorphText({ text, animate = true }: { text: string; animate?: boolean }) {
  const [shown, setShown] = useState<{ text: string; outgoing: string | null; key: number }>({ text, outgoing: null, key: 0 });
  if (shown.text !== text) {
    setShown({ text, outgoing: animate ? shown.text : null, key: animate ? shown.key + 1 : shown.key });
  }
  const { outgoing } = shown;
  useEffect(() => {
    if (outgoing === null) return;
    // Its lift-away takes 200 ms; with reduced motion there is none, so this alone clears it.
    const timer = setTimeout(() => setShown((current) => ({ ...current, outgoing: null })), 260);
    return () => clearTimeout(timer);
  }, [outgoing]);
  return (
    <span className="morph">
      <span key={shown.key} className={shown.key > 0 ? "morph-in" : undefined}>
        {shown.text}
      </span>
      {outgoing !== null ? (
        <span aria-hidden className="morph-out">
          {outgoing}
        </span>
      ) : null}
    </span>
  );
}

/** Grows and shrinks a block's height smoothly; folded, it is gone for screen readers and focus too. */
function Fold({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`fold ${open ? "" : "is-folded"}`} inert={!open} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}

function Track({
  percent,
  thin = false,
  waiting = false,
  label,
  className = "",
}: {
  percent: number;
  thin?: boolean;
  /** Retrying: the bar holds where it was, in stone. */
  waiting?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-valuenow={label ? percent : undefined}
      className={`overflow-hidden bg-tray ${thin ? "h-1 rounded-[2px]" : "h-1.5 rounded-[3px]"} ${className}`}
    >
      <div
        className={`h-full rounded-[inherit] transition-[width,background-color] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] ${waiting ? "bg-stone" : "bg-ember"}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** The guest's own file, small: its picture, or a video's first frame; the tile colour where neither shows. */
function Preview({ item, className }: { item: UploadItem; className: string }) {
  const [broken, setBroken] = useState(false);
  if (!item.previewUrl || broken) return <span className={className} />;
  if (item.kind === "video") {
    // #t=0.1 makes iPhones draw the first frame instead of a blank box.
    return <video src={`${item.previewUrl}#t=0.1`} muted playsInline preload="metadata" className={className} onError={() => setBroken(true)} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a local preview of the guest's own file
    <img src={item.previewUrl} alt="" decoding="async" loading="lazy" className={className} onError={() => setBroken(true)} />
  );
}

/** A thumbnail with its status badge: the camera card's (always on) or a row's (once it has news). */
function Thumb({ item, variant }: { item: UploadItem; variant: "camera" | "row" }) {
  const camera = variant === "camera";
  const { status } = item;
  const badgeShown = camera || status === "added" || status === "failed" || status === "retrying";
  return (
    <span data-status={status} className={`relative shrink-0 ${camera ? "-mb-1.5 size-[62px]" : "-mb-[5px] size-[49px]"}`}>
      <Preview
        item={item}
        className={`absolute rounded-[3px] bg-tile object-cover transition-opacity duration-300 ${camera ? "inset-[0_6px_6px_0] size-[56px]" : "inset-[0_5px_5px_0] size-[44px]"} ${status === "queued" && !camera ? "opacity-55" : ""}`}
      />
      {item.kind === "video" && !camera ? (
        <span aria-hidden className="absolute bottom-1 left-1 grid size-4 place-items-center rounded-full bg-white/95 text-cocoa">
          <svg width="7" height="7" viewBox="0 0 24 24" aria-hidden>
            <path d="M8 4.5l12 7.5-12 7.5z" fill="currentColor" />
          </svg>
        </span>
      ) : null}
      <span className={`upload-badge ${camera ? "size-5.5" : "size-[18px]"} ${badgeShown ? "" : "scale-60 opacity-0"}`}>
        {status === "failed" ? (
          <Icon name="alert" size={camera ? 12 : 10} strokeWidth={2.6} />
        ) : status === "retrying" ? (
          <Icon name="retry" size={camera ? 12 : 10} strokeWidth={2.2} className="upload-retry" />
        ) : (
          <>
            {camera ? <span className="upload-spinner" /> : null}
            <Icon name="check" size={camera ? 12 : 10} strokeWidth={2.4} className="upload-tick" />
          </>
        )}
      </span>
    </span>
  );
}

/** The file as a screen reader names it: "photo", "video 3". */
function nounOf(item: UploadItem, position?: number): string {
  return `${item.kind === "video" ? "video" : "photo"}${position === undefined ? "" : ` ${position}`}`;
}

/**
 * An × for one file: Cancel while it is on its way (it stops, and comes out of the album if it had
 * already arrived), Dismiss once it has failed (it leaves the card). A 44 px tap target; in a row,
 * the × sits at the row's right edge.
 */
function ItemButton({
  item,
  action,
  label,
  onClick,
  edge = false,
  className = "",
}: {
  item: UploadItem;
  action: "cancel" | "dismiss";
  label: string;
  onClick: () => void;
  edge?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-item-action={item.id}
      data-action={action}
      className={`grid size-11 shrink-0 cursor-pointer items-center rounded-full border-0 bg-transparent p-0 text-mocha ${edge ? "justify-items-end" : "justify-items-center"} ${className}`}
    >
      <Icon name="close" size={16} />
    </button>
  );
}

const emberButton =
  "press flex min-h-11 shrink-0 cursor-pointer items-center rounded-full border-0 bg-ember px-4 text-[11px] font-medium uppercase tracking-[0.14em] text-cocoa";
const outlineButton =
  "press flex min-h-10 shrink-0 cursor-pointer items-center rounded-full border border-ember/55 bg-transparent px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-cocoa";

export type ItemActions = {
  onRetry: (itemId: string) => void;
  onCancel: (itemId: string) => void;
  onDismiss: (itemId: string) => void;
};

/** One shot from the camera: "Sending to the album" with the guest's own picture, then "Added". */
export function CameraCard({ item, onRetry, onCancel, onDismiss, onTakeAnother }: { item: UploadItem; onTakeAnother: () => void } & ItemActions) {
  const { status, failure, kind, percent } = item;
  const added = status === "added";
  const busy = isBusy(item);
  const caption = failure ? failure.hint : CAMERA_CAPTIONS[status];
  const noun = nounOf(item);
  return (
    <section
      aria-label={`Your ${noun}`}
      data-upload-card
      tabIndex={-1}
      className="relative flex animate-rise flex-col gap-3 rounded-[var(--radius-paper)] bg-white p-3 shadow-[var(--shadow-paper)] outline-none"
    >
      <div className={`flex items-center gap-2 ${busy || failure ? "pr-9" : ""}`}>
        <Thumb item={item} variant="camera" />
        <div className="flex min-w-0 flex-col gap-0.5" aria-live="polite">
          <p className="m-0 font-serif text-xl leading-[1.2] italic">
            {failure ? (
              failure.reason
            ) : (
              <>
                <MorphText text={added ? "Added" : "Sending"} /> to the album
              </>
            )}
          </p>
          {caption ? <p className="m-0 text-xs leading-[1.45] text-mocha">{caption}</p> : null}
        </div>
      </div>
      {/* Sharing closed: nothing to try again or take another of. */}
      {failure?.closed ? null : (
        <div className="flex min-h-11 items-center gap-3">
          {failure ? null : (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Track
                percent={percent}
                waiting={status === "retrying"}
                label={added ? undefined : `Sending your ${noun}`}
                className="flex-1"
              />
              <span className={`min-w-[4ch] text-right text-xs font-medium tabular-nums transition-colors duration-300 ${added ? "text-ember-ink" : "text-mocha"}`}>
                <MorphText text={added ? "Sent" : `${percent}%`} animate={added} />
              </span>
            </div>
          )}
          {failure?.canRetry ? (
            <button type="button" onClick={() => onRetry(item.id)} data-item-retry={item.id} className={`${emberButton} ml-auto`}>
              Try again
            </button>
          ) : (
            <button type="button" onClick={onTakeAnother} className={`${emberButton} ml-auto`}>
              {kind === "video" ? "Record another" : "Take another"}
            </button>
          )}
        </div>
      )}
      {busy ? (
        <ItemButton item={item} action="cancel" label={`Cancel ${noun}`} onClick={() => onCancel(item.id)} className="absolute top-1.5 right-1.5" />
      ) : failure ? (
        <ItemButton item={item} action="dismiss" label={`Dismiss ${noun}`} onClick={() => onDismiss(item.id)} className="absolute top-1.5 right-1.5" />
      ) : null}
    </section>
  );
}

function BatchRow({ item, position, onRetry, onCancel, onDismiss }: { item: UploadItem; position: number } & ItemActions) {
  const { status, failure, percent } = item;
  const label = failure ? failure.reason : ROW_WORDS[status as keyof typeof ROW_WORDS];
  const sending = status === "sending" || status === "confirming";
  const labelColour = failure ? "text-ember-ink" : status === "queued" || status === "retrying" ? "text-mocha" : "text-cocoa";
  const noun = nounOf(item, position);
  return (
    <li
      aria-label={`${noun.charAt(0).toUpperCase()}${noun.slice(1)}`}
      className="grid grid-cols-[49px_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-hairline py-2.5"
    >
      <Thumb item={item} variant="row" />
      <div className="flex min-w-0 flex-col">
        <p className="m-0 flex items-baseline gap-2">
          <span className={`min-w-0 text-[13px] leading-[1.35] transition-colors duration-300 ${labelColour}`}>{label}</span>
          {sending ? <span className="ml-auto text-xs font-medium text-mocha tabular-nums">{percent}%</span> : null}
        </p>
        <Fold open={sending || status === "retrying"}>
          <Track percent={percent} thin waiting={status === "retrying"} className="mt-[7px]" />
        </Fold>
        {failure?.hint ? <p className="m-0 mt-0.5 text-xs leading-[1.45] text-mocha">{failure.hint}</p> : null}
        {failure?.canRetry ? (
          <button type="button" onClick={() => onRetry(item.id)} data-item-retry={item.id} className={`${outlineButton} mt-1.5 self-start`}>
            Try again
          </button>
        ) : null}
      </div>
      {isBusy(item) ? (
        <ItemButton item={item} action="cancel" label={`Cancel ${noun}`} onClick={() => onCancel(item.id)} edge className="-my-2" />
      ) : failure ? (
        <ItemButton item={item} action="dismiss" label={`Dismiss ${noun}`} onClick={() => onDismiss(item.id)} edge className="-my-2" />
      ) : (
        <span />
      )}
    </li>
  );
}

/** Several files from the gallery: "Sending to the album · N of M sent", a row for each file. */
export function BatchCard({ view, ...actions }: { view: Extract<UploadView, { kind: "batch" }> } & ItemActions) {
  const { items, sent, total, busy, percent } = view;
  const verb = busy ? "Sending" : sent > 0 ? "Added" : "Not added";
  return (
    <section
      aria-label="Your photos and videos"
      data-upload-card
      tabIndex={-1}
      className="flex animate-rise flex-col rounded-[var(--radius-paper)] bg-white p-4 shadow-[var(--shadow-paper)] outline-none"
    >
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden
          className={`relative grid size-10 shrink-0 place-items-center rounded-full transition-colors duration-300 ${busy ? "bg-halo text-ember" : "bg-ember text-white"}`}
        >
          <Icon
            name="upload"
            size={17}
            className={`col-start-1 row-start-1 transition-[opacity,transform] duration-300 ${busy ? "" : "-translate-y-1.5 opacity-0"}`}
          />
          <Icon
            name="check"
            size={17}
            strokeWidth={2.2}
            className={`col-start-1 row-start-1 transition-[opacity,transform] duration-300 ${busy ? "scale-50 opacity-0" : ""}`}
          />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5" aria-live="polite">
          <p className="m-0 font-serif text-xl leading-[1.2] italic">
            <MorphText text={verb} /> to the album
          </p>
          <p className="m-0 text-[13px] font-medium tabular-nums">
            {sent} of {total} sent
          </p>
        </div>
      </div>
      <Fold open={busy}>
        <Track percent={percent} label="All files" className="mt-3.5" />
      </Fold>
      <ul className="m-0 mt-3.5 list-none p-0">
        {items.map((item, index) => (
          <BatchRow key={item.id} item={item} position={index + 1} {...actions} />
        ))}
      </ul>
      <Fold open={busy}>
        <p className="m-0 border-t border-hairline pt-3 text-xs leading-[1.45] text-mocha">Keep this page open while they send.</p>
      </Fold>
      {/* Each row's failure, told politely as it happens. */}
      <div className="sr-only" aria-live="polite">
        {items.map((item, index) =>
          item.failure ? (
            <p key={item.id}>
              {nounOf(item, index + 1)}: {item.failure.reason}
            </p>
          ) : null,
        )}
      </div>
    </section>
  );
}
