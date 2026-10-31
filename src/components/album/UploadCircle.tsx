"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { isBusy, type UploadSnapshot } from "./uploader/state";

/*
 * The minimised uploads (Ruling BE, Noblet: "a small floating circle or round floating progress
 * bar"): a round button in the dock's corner, beside the music, with an ember ring around its edge
 * for the bytes sent and, in its centre, a single file's percentage or how many files are still to
 * arrive. Tapped, the card opens again. Once everything has arrived the centre turns into gate A's
 * drawn check with one ember pulse, and after about 2 s the circle fades away; if a file didn't
 * send, it wears a small "!" and stays until opened. With reduced motion the ring jumps, there is
 * no pulse and no fade (the site's reduced-motion rules stop them).
 */

/** What the floating progress circle shows of the card it stands in for (Ruling BE). */
export type CircleState = {
  /** Of the bytes still to arrive, the share sent: the ring. */
  percent: number;
  /** A single file's percentage, or how many files are still to arrive; empty once everything has. */
  centre: string;
  /** A file didn't send: the circle wears a "!" and stays until opened. */
  failed: boolean;
  /** Everything has arrived: the check, then the circle fades. */
  done: boolean;
  /** Its name for a screen reader. */
  label: string;
};

export function circleOf(snapshot: Pick<UploadSnapshot, "view">): CircleState | null {
  const { view } = snapshot;
  if (view.kind === "none") return null;
  const items = view.kind === "camera" ? [view.item] : view.items;
  const percent = view.kind === "camera" ? view.item.percent : view.percent;
  const failedCount = items.filter((item) => item.status === "failed").length;
  const busy = items.some(isBusy);
  const done = !busy && failedCount === 0;
  const single = view.kind === "camera" || view.total === 1;
  const stillToArrive = items.filter((item) => item.status !== "added").length;
  return {
    percent,
    centre: done ? "" : single ? `${percent}%` : String(stillToArrive),
    failed: failedCount > 0,
    done,
    label: done ? "Show uploads, all sent" : !busy ? `Show uploads, ${failedCount} didn't send` : `Show uploads, ${percent}% sent`,
  };
}

const RADIUS = 25.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Once everything has arrived, the check shows this long before the circle fades. */
const DONE_SHOWN_MILLISECONDS = 2_000;
const FADE_MILLISECONDS = 300;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** What a screen reader hears as the circle's news comes in: each quarter sent, a failure, then the end. */
function milestoneOf(circle: CircleState): string {
  if (circle.done) return "All your files have arrived.";
  const sent = `Uploads: ${Math.floor(circle.percent / 25) * 25}% sent.`;
  return circle.failed ? `${sent} Something didn't send; open your uploads to see.` : sent;
}

export function UploadCircle({
  snapshot,
  onOpen,
  onGone,
}: {
  snapshot: Pick<UploadSnapshot, "view">;
  onOpen: () => void;
  /** Called just before the circle goes, with whether it held the focus. */
  onGone: (hadFocus: boolean) => void;
}) {
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  const button = useRef<HTMLButtonElement>(null);
  const circle = circleOf(snapshot);
  const done = circle?.done ?? false;

  useEffect(() => {
    if (!done) return;
    const reduced = prefersReducedMotion();
    const leave = () => {
      onGone(document.activeElement === button.current);
      setPhase("gone");
    };
    const timers = [
      setTimeout(() => (reduced ? leave() : setPhase("fading")), DONE_SHOWN_MILLISECONDS),
      ...(reduced ? [] : [setTimeout(leave, DONE_SHOWN_MILLISECONDS + FADE_MILLISECONDS)]),
    ];
    return () => timers.forEach(clearTimeout);
    // Once, when everything has arrived; onGone is the album's own, stable for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  if (phase === "gone" || !circle) return null;
  const state = done ? "done" : circle.failed ? "failed" : "sending";
  const single = circle.centre.endsWith("%");
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={onOpen}
        aria-label={circle.label}
        data-upload-circle
        data-state={state}
        className={`upload-circle press relative grid size-14 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-white p-0 text-cocoa shadow-[var(--shadow-pill-white)] transition-[opacity,scale] duration-300 ${
          phase === "fading" ? "scale-90 opacity-0" : ""
        }`}
      >
        <svg data-ring data-percent={circle.percent} viewBox="0 0 56 56" aria-hidden className="absolute inset-0 size-full -rotate-90">
          <circle cx="28" cy="28" r={RADIUS} fill="none" stroke="var(--color-tray)" strokeWidth="3" />
          <circle
            cx="28"
            cy="28"
            r={RADIUS}
            fill="none"
            stroke="var(--color-ember)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - circle.percent / 100)}
            className={`upload-ring ${circle.percent > 0 ? "" : "opacity-0"}`}
          />
        </svg>
        <span
          aria-hidden
          className={`upload-circle-count col-start-1 row-start-1 font-medium tabular-nums ${single ? "text-[13px]" : "text-base"}`}
        >
          {circle.centre}
        </span>
        <span aria-hidden className="upload-circle-check col-start-1 row-start-1 grid size-10 place-items-center rounded-full bg-ember text-white">
          <Icon name="check" size={18} strokeWidth={2.4} className="upload-tick" />
        </span>
        {circle.failed ? (
          <span
            aria-hidden
            className="absolute top-0 right-0 grid size-5 place-items-center rounded-full bg-halo text-ember-ink shadow-[0_0_0_2px_#fff]"
          >
            <Icon name="alert" size={11} strokeWidth={2.6} />
          </span>
        ) : null}
      </button>
      {/* Its news, told politely: each quarter sent, then the end (not every percent). */}
      <span className="sr-only" aria-live="polite">
        {milestoneOf(circle)}
      </span>
    </>
  );
}
