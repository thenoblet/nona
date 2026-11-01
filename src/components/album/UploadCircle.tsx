"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { isBusy, type UploadSnapshot } from "./uploader/state";

/*
 * The minimised uploads (Ruling BE, Noblet: "a small floating circle or round floating progress
 * bar"): a round button in the dock's corner, beside the music, with an ember ring around its edge
 * for the bytes sent and, in its centre, a single file's percentage or how many files are still
 * sending. Tapped, the card opens again; the card morphs into it and back (Ruling BI, the album's
 * morph). Once everything has arrived (Ruling BJ) the ring completes, an ember disc pops, its tick
 * draws, one ember pulse goes out, and about 2 s later the circle fades away.
 *
 * A failure looks like an error notice (Ruling BK): the ring turns red (filling on with the others'
 * bytes while they send, full once none is), a solid red badge with a
 * white "!" sits on it, it shakes once as the failure arrives, and a small red-tinted label beside
 * it says "1 didn't send · Tap to see" until the guest taps. With reduced motion the ring jumps, and
 * there is no shake, pop, draw, pulse or fade (the site's reduced-motion rules stop them).
 */

/** What the floating progress circle shows of the card it stands in for. */
export type CircleState = {
  /** Of the bytes still to arrive, and those that arrived, the share sent: the ring. */
  percent: number;
  /** A single file's percentage, or how many files are still sending; empty when none is. */
  centre: string;
  /** Files that didn't send. */
  failedCount: number;
  /** Whether any file is still on its way. */
  sending: boolean;
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
  const stillSending = items.filter(isBusy).length;
  const sending = stillSending > 0;
  const done = !sending && failedCount === 0;
  const single = view.kind === "camera" || view.total === 1;
  const didntSend = `${failedCount} didn't send`;
  return {
    percent,
    centre: !sending ? "" : single ? `${percent}%` : String(stillSending),
    failedCount,
    sending,
    done,
    label: done
      ? "Show uploads, all sent"
      : !sending
        ? `Show uploads, ${didntSend}`
        : `Show uploads, ${percent}% sent${failedCount > 0 ? `, ${didntSend}` : ""}`,
  };
}

/**
 * The ring: ember, filling with the bytes sent. Once a file has failed it turns red, and still fills
 * with what the others send while they do; only when nothing is sending is it a full red ring, so
 * even a lone file that failed before its first byte shows one.
 */
export function ringOf(circle: CircleState): { filled: number; tone: "ember" | "alert" } {
  if (circle.failedCount === 0) return { filled: circle.percent, tone: "ember" };
  return { filled: circle.sending ? circle.percent : 100, tone: "alert" };
}

/** What a screen reader hears as the circle's news comes in: each quarter sent, a failure, then the end. */
export function milestoneOf(circle: CircleState): string {
  if (circle.done) return "All your files have arrived.";
  const failure = `${circle.failedCount} didn't send; open your uploads to see.`;
  if (!circle.sending) return failure;
  const sent = `Uploads: ${Math.floor(circle.percent / 25) * 25}% sent.`;
  return circle.failedCount > 0 ? `${sent} ${failure}` : sent;
}

const RADIUS = 25.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Once everything has arrived: the ring, the disc, the tick and the pulse take about 1.3 s; then a moment to see it. */
const DONE_SHOWN_MILLISECONDS = 2_600;
const FADE_MILLISECONDS = 300;
/** The shake as a failure arrives. */
const SHAKE_MILLISECONDS = 480;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
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
  const failed = (circle?.failedCount ?? 0) > 0;
  const failedBefore = useRef(failed);

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

  // One shake as a failure arrives while the circle shows (not when it opens on one already there).
  // An animation of its own, so it never restarts the circle's pop-in when it ends.
  useEffect(() => {
    const arrived = failed && !failedBefore.current;
    failedBefore.current = failed;
    if (!arrived || prefersReducedMotion()) return;
    const shake = button.current?.animate?.(
      [0, -4, 4, -4, 4, -2, 2, 0].map((pixels) => ({ translate: `${pixels}px 0` })),
      { duration: SHAKE_MILLISECONDS, easing: "cubic-bezier(0.36, 0.07, 0.19, 0.97)" },
    );
    return () => shake?.cancel();
  }, [failed]);

  if (phase === "gone" || !circle) return null;
  const state = done ? "done" : failed ? "failed" : "sending";
  const ring = ringOf(circle);
  const single = circle.centre.endsWith("%");
  return (
    <div className={`flex items-center gap-2 transition-[opacity,scale] duration-300 ${phase === "fading" ? "scale-90 opacity-0" : ""}`}>
      <button
        ref={button}
        type="button"
        onClick={onOpen}
        aria-label={circle.label}
        data-upload-circle
        data-state={state}
        className="upload-circle press relative grid size-14 shrink-0 cursor-pointer place-items-center rounded-full border-0 bg-white p-0 text-cocoa shadow-[var(--shadow-pill-white)]"
      >
        <svg data-ring data-percent={circle.percent} viewBox="0 0 56 56" aria-hidden className="absolute inset-0 size-full -rotate-90">
          <circle cx="28" cy="28" r={RADIUS} fill="none" stroke="var(--color-tray)" strokeWidth="3" />
          <circle
            cx="28"
            cy="28"
            r={RADIUS}
            fill="none"
            stroke={ring.tone === "alert" ? "var(--color-alert)" : "var(--color-ember)"}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - ring.filled / 100)}
            className={`upload-ring ${ring.filled > 0 ? "" : "opacity-0"}`}
          />
        </svg>
        {/* Only what is still sending; a failure is the red ring's, the badge's and the label's to say. */}
        <span
          aria-hidden
          className={`upload-circle-count col-start-1 row-start-1 font-medium tabular-nums ${single ? "text-[13px]" : "text-base"}`}
        >
          {circle.centre}
        </span>
        <span aria-hidden className="upload-circle-check col-start-1 row-start-1 grid size-10 place-items-center rounded-full bg-ember text-white">
          {/* pathLength 1: the whole tick draws, whatever its real length. */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path className="upload-circle-tick" pathLength={1} d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        {failed ? (
          <span aria-hidden className="absolute top-0 right-0 grid size-5 place-items-center rounded-full bg-alert text-white shadow-[0_0_0_2px_#fff]">
            <Icon name="alert" size={12} strokeWidth={2.6} />
          </span>
        ) : null}
      </button>
      {failed ? (
        // The toast beside it, for a tap: the circle's own name already says it for a screen reader.
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={onOpen}
          data-upload-failure-label
          className="upload-failure-label flex cursor-pointer flex-col rounded-[3px] border-0 border-l-[3px] border-alert bg-alert-tint px-2.5 py-1.5 text-left text-xs leading-[1.3] shadow-[var(--shadow-pill-white)] min-[380px]:flex-row min-[380px]:gap-1"
        >
          <span className="font-medium whitespace-nowrap text-alert">{circle.failedCount} didn&rsquo;t send</span>
          <span className="whitespace-nowrap text-cocoa">
            <span className="hidden min-[380px]:inline">· </span>Tap to see
          </span>
        </button>
      ) : null}
      {/* Its news, told politely: each quarter sent, a failure, then the end (not every percent). */}
      <span className="sr-only" aria-live="polite">
        {milestoneOf(circle)}
      </span>
    </div>
  );
}
