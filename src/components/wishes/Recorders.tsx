"use client";

import { useEffect, useRef, useState, type ComponentType, type Dispatch } from "react";
import { Icon } from "@/components/ui/Icon";
import { isChunkLoadError, loadEngine, reloadOnceAfterChunkError } from "@/components/album/uploader/load";
import type { RecorderEvent, RecorderState } from "./recorder-machine";
import { mediaConstraints, pickRecordingType, type RecordedKind } from "./recording";
import type { RecorderPanelProps } from "./RecorderPanel";
import type { WishSenderProps } from "./WishSender";

/*
 * The voice and video recorders' first-load part (gate B 4a, 4b): what a guest sees before they tap,
 * and the tap itself. Everything else (the recording, listening back, the fallback, and the upload
 * client) is loaded on that first tap (Ruling BU), while the phone shows its own prompt for the
 * microphone or camera, which this asks for at once so the guest never waits on a download first.
 */

type PanelModule = { default: ComponentType<RecorderPanelProps> };
type SenderModule = { default: ComponentType<WishSenderProps> };

let panelLoading: Promise<PanelModule> | null = null;
let senderLoading: Promise<SenderModule> | null = null;

/** The recorder's panel, loaded once; a failed load is tried again on the next tap. */
function loadPanel(): Promise<PanelModule> {
  panelLoading ??= import("./RecorderPanel").catch((error: unknown) => {
    panelLoading = null;
    throw error;
  });
  return panelLoading;
}

/** The sending card (with the upload client), loaded once, from the first tap; a failed load is tried again on Send. */
export function loadWishSender(): Promise<SenderModule> {
  senderLoading ??= import("./WishSender").catch((error: unknown) => {
    senderLoading = null;
    throw error;
  });
  return senderLoading;
}

/** The tab's session storage, or null where the browser blocks it. */
function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Asks the phone for the microphone (and the front camera, for a video), only where this browser can
 * record what it gives: no camera API, no MediaRecorder, or no type we take is the same refusal
 * (NotSupportedError) as a "no" at the prompt, and hands over to the phone's own recorder.
 */
function askForMedia(kind: RecordedKind): Promise<MediaStream> {
  const recorder = typeof MediaRecorder === "undefined" ? null : MediaRecorder;
  const ask = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
  if (!recorder || !ask || !pickRecordingType(kind, (type) => recorder.isTypeSupported(type))) {
    return Promise.reject(new DOMException("This browser can't record here", "NotSupportedError"));
  }
  return ask(mediaConstraints(kind));
}

export type RecorderProps = {
  kind: RecordedKind;
  state: RecorderState;
  dispatch: Dispatch<RecorderEvent>;
};

/**
 * One recorder on the wishes page. Idle, it is gate B's mic button ("Tap to record · up to 60
 * seconds") or camera frame ("Up to 30 seconds · front camera"); from the first tap, the loaded panel.
 */
export function Recorder({ kind, state, dispatch }: RecorderProps) {
  const [Panel, setPanel] = useState<ComponentType<RecorderPanelProps> | null>(null);
  const media = useRef<Promise<MediaStream> | null>(null);

  // A stream asked for but never handed to a panel (the page went first) is let go.
  useEffect(
    () => () => {
      void media.current?.then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => {});
    },
    [],
  );

  function start() {
    media.current = askForMedia(kind);
    media.current.catch(() => {});
    dispatch({ type: "tap" });
    // The sending card and the upload client too, so they are ready by the time the guest sends.
    loadWishSender().catch(() => {});
    loadEngine().catch(() => {});
    loadPanel().then(
      (loaded) => setPanel(() => loaded.default),
      (error: unknown) => {
        if (isChunkLoadError(error)) {
          // A chunk a deploy removed: the page reloads once, never in a loop (load.ts).
          reloadOnceAfterChunkError({ storage: sessionStorageOrNull(), reload: () => window.location.reload(), now: Date.now() });
        }
        dispatch({ type: "refused", why: "unsupported" });
        setPanel(null);
      },
    );
  }

  if (state.phase === "idle" || !Panel) {
    return <IdleRecorder kind={kind} waiting={state.phase !== "idle"} onTap={start} />;
  }
  return <Panel kind={kind} state={state} dispatch={dispatch} media={media} />;
}

/** Gate B's ready state; `waiting` once tapped, while the panel loads or the phone asks. */
export function IdleRecorder({ kind, waiting, onTap }: { kind: RecordedKind; waiting: boolean; onTap: () => void }) {
  if (kind === "voice") {
    return (
      <div className="flex flex-col items-center gap-4 pt-5.5 pb-3">
        <button
          type="button"
          aria-label="Start recording a voice note"
          aria-busy={waiting || undefined}
          disabled={waiting}
          onClick={onTap}
          className={`press flex size-23 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)] disabled:cursor-default ${waiting ? "" : "animate-seal-pulse"}`}
        >
          <Icon name="mic" size={32} />
        </button>
        <p className="m-0 text-center font-serif text-[19px] text-mocha italic" aria-live="polite">
          {waiting ? "Allow the microphone to start recording" : "Tap to record · up to 60 seconds"}
        </p>
      </div>
    );
  }
  return (
    <div className="relative flex aspect-[4/5] flex-col items-center justify-end gap-3.5 overflow-hidden rounded-[var(--radius-paper)] bg-cocoa pb-7 text-white">
      <span aria-hidden className="absolute inset-4.5 rounded-[2px] border border-ember/40" />
      <p className="relative m-0 px-6 text-center font-serif text-[19px] text-mist italic" aria-live="polite">
        {waiting ? "Allow the camera to start" : "Up to 30 seconds · front camera"}
      </p>
      <button
        type="button"
        aria-label="Start recording a video message"
        aria-busy={waiting || undefined}
        disabled={waiting}
        onClick={onTap}
        className="press relative size-18 cursor-pointer rounded-full border-4 border-white bg-ember shadow-[0_6px_16px_rgb(0_0_0/0.3)] disabled:cursor-default disabled:opacity-70"
      />
    </div>
  );
}
