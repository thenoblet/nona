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
/**
 * The panel once it has loaded, kept for the page: a recorder mounted again past idle (its take kept
 * while the sending card was up) shows it at once.
 */
let loadedPanel: ComponentType<RecorderPanelProps> | null = null;

/** The recorder's panel, loaded once; a failed load is tried again on the next tap. */
function loadPanel(): Promise<PanelModule> {
  panelLoading ??= import("./RecorderPanel").then(
    (loaded) => {
      loadedPanel = loaded.default;
      return loaded;
    },
    (error: unknown) => {
      panelLoading = null;
      throw error;
    },
  );
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

/** Lets go of a stream asked for: every track stops, so the phone's camera or microphone light goes off. */
function stopStream(asked: Promise<MediaStream> | null): void {
  void asked?.then((stream) => stream.getTracks().forEach((track) => track.stop())).catch(() => {});
}

/** The recorder's own code didn't load (gate A's way: a plain reason, and Try again). */
export const RECORDER_DIDNT_LOAD = "The recorder didn't load. Check the connection, then try again.";

export type RecorderProps = {
  kind: RecordedKind;
  state: RecorderState;
  dispatch: Dispatch<RecorderEvent>;
};

/**
 * One recorder on the wishes page. Idle, it is gate B's mic button ("Tap to record · up to 60
 * seconds") or camera frame ("Up to 30 seconds · front camera"); from the first tap, the loaded panel.
 * Should the panel not load (no signal, twice), the camera or microphone the tap asked for is let go
 * at once, and the recorder is idle again, saying so, with Try again: never stuck, never left on.
 */
export function Recorder({ kind, state, dispatch }: RecorderProps) {
  const [Panel, setPanel] = useState<ComponentType<RecorderPanelProps> | null>(() => loadedPanel);
  const [problem, setProblem] = useState<string | null>(null);
  const media = useRef<Promise<MediaStream> | null>(null);

  // A stream asked for but never handed to a panel (the page went first) is let go.
  useEffect(
    () => () => {
      stopStream(media.current);
    },
    [],
  );

  // Past idle with no panel yet (just tapped, or mounted again with a take): it loads.
  const needsPanel = state.phase !== "idle" && Panel === null;
  useEffect(() => {
    if (!needsPanel) return;
    let current = true;
    loadPanel().then(
      (loaded) => {
        if (current) setPanel(() => loaded.default);
      },
      (error: unknown) => {
        if (!current) return;
        // A chunk a deploy removed: the page reloads once, never in a loop (load.ts).
        if (isChunkLoadError(error) && reloadOnceAfterChunkError({ storage: sessionStorageOrNull(), reload: () => window.location.reload(), now: Date.now() })) {
          return;
        }
        stopStream(media.current);
        media.current = null;
        dispatch({ type: "reset" });
        setProblem(RECORDER_DIDNT_LOAD);
      },
    );
    return () => {
      current = false;
    };
  }, [needsPanel, dispatch]);

  function start() {
    setProblem(null);
    media.current = askForMedia(kind);
    media.current.catch(() => {});
    dispatch({ type: "tap" });
    // The sending card and the upload client too, so they are ready by the time the guest sends.
    loadWishSender().catch(() => {});
    loadEngine().catch(() => {});
  }

  if (state.phase === "idle" || !Panel) {
    return <IdleRecorder kind={kind} waiting={state.phase !== "idle"} problem={state.phase === "idle" ? problem : null} onTap={start} />;
  }
  return <Panel kind={kind} state={state} dispatch={dispatch} media={media} />;
}

/** Gate B's ready state; `waiting` once tapped, while the panel loads or the phone asks; `problem` when the panel didn't load. */
export function IdleRecorder({
  kind,
  waiting,
  problem,
  onTap,
}: {
  kind: RecordedKind;
  waiting: boolean;
  problem: string | null;
  onTap: () => void;
}) {
  const retry = problem ? (
    <span role="alert" className="flex flex-col items-center gap-0.5 px-6 text-center text-sm">
      <span>{problem}</span>
      <button
        type="button"
        onClick={onTap}
        className="ember-link inline-flex min-h-11 cursor-pointer items-center text-xs uppercase tracking-[0.18em]"
      >
        Try again
      </button>
    </span>
  ) : null;
  if (kind === "voice") {
    return (
      <div className="flex flex-col items-center gap-4 pt-5.5 pb-3">
        <button
          type="button"
          aria-label="Start recording a voice note"
          aria-busy={waiting || undefined}
          disabled={waiting}
          onClick={onTap}
          className={`press flex size-23 cursor-pointer items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)] disabled:cursor-default ${waiting || problem ? "" : "animate-seal-pulse"}`}
        >
          <Icon name="mic" size={32} />
        </button>
        <p className="m-0 text-center font-serif text-[19px] text-mocha italic" aria-live="polite">
          {waiting ? "Allow the microphone to start recording" : "Tap to record · up to 60 seconds"}
        </p>
        {retry ? <span className="text-ember-ink">{retry}</span> : null}
      </div>
    );
  }
  return (
    <div className="relative flex aspect-[4/5] flex-col items-center justify-end gap-3.5 overflow-hidden rounded-[var(--radius-paper)] bg-cocoa pb-7 text-white">
      <span aria-hidden className="absolute inset-4.5 rounded-[2px] border border-ember/40" />
      {retry ? <span className="relative text-linen">{retry}</span> : null}
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
