"use client";

import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject } from "react";
import { Halo } from "@/components/ui/Halo";
import { Icon, PauseGlyph, PlayGlyph } from "@/components/ui/Icon";
import { copyText } from "@/components/album/viewer/device";
import { declaredType } from "@/components/album/uploader/state";
import { checkUpload, WISH_SECONDS } from "@/lib/media/limits";
import { clockTime } from "@/lib/media/album-item";
import { blockedWhyOf, secondsLeft, takeSeconds, type RecorderEvent, type RecorderState, type Take } from "./recorder-machine";
import {
  AUDIO_BITS_PER_SECOND,
  declaredRecordingType,
  pickRecordingType,
  recordingFileName,
  VIDEO_BITS_PER_SECOND,
  type RecordedKind,
} from "./recording";
import { holdTakeUrl, takeUrlOf } from "./take-url";

/*
 * The recorder itself (gate B 4a, 4b, 4d), loaded on the first tap (Ruling BU): MediaRecorder on
 * the stream the tap asked for, with the type and bitrates of Ruling BT; the ring and "0:41 left";
 * a video message's 3, 2, 1 over the live front camera (mirrored, like a selfie); listening or
 * watching back; and, when the browser says no, the hand-over to the phone's own camera or recorder
 * through a file input with `capture`. The composer keeps the state (recorder-machine.ts); this
 * does what each state asks of the browser, and stops the camera and microphone as soon as a
 * recording ends, so the phone's recording light never stays on.
 */

export type RecorderPanelProps = {
  kind: RecordedKind;
  state: RecorderState;
  dispatch: Dispatch<RecorderEvent>;
  /** The stream the first tap asked for (or its refusal). */
  media: RefObject<Promise<MediaStream> | null>;
};

/** How often the clock moves the ring while recording. */
const TICK_MILLISECONDS = 250;
/** A picked file's length is read from the phone's media element, or left unknown after this long. */
const LENGTH_READ_MILLISECONDS = 5_000;
/** The listen-back waveform's bars (gate B), the played part in ember. */
const WAVE_HEIGHTS = [6, 14, 8, 18, 10, 4, 16, 10, 6, 20, 12, 6, 14, 8, 16, 4, 12, 8, 18, 10, 6, 14, 8, 12, 4, 10, 16, 6];

function stopTracks(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

export default function RecorderPanel({ kind, state, dispatch, media }: RecorderPanelProps) {
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  /** The recording's length when it was stopped, for its take. */
  const stoppedAfter = useRef<number | null>(null);
  /** When the recorder started (performance.now()), for a take the browser stops by itself. */
  const startedAt = useRef<number | null>(null);
  const [live, setLive] = useState<MediaStream | null>(null);
  const preview = useRef<HTMLVideoElement>(null);

  // Gone from the page (the guest switched tab, or sent): the recorder and the camera stop, unheard.
  useEffect(
    () => () => {
      const current = recorder.current;
      if (current && current.state !== "inactive") {
        current.ondataavailable = null;
        current.onstop = null;
        try {
          current.stop();
        } catch {
          // Already stopping.
        }
      }
      stopTracks(stream.current);
    },
    [],
  );

  function startRecording() {
    const given = stream.current;
    if (!given) {
      dispatch({ type: "refused", why: "failed" });
      return;
    }
    const mimeType = pickRecordingType(kind, (type) => MediaRecorder.isTypeSupported(type)) ?? undefined;
    let made: MediaRecorder;
    try {
      made = new MediaRecorder(given, {
        mimeType,
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
        ...(kind === "video" ? { videoBitsPerSecond: VIDEO_BITS_PER_SECOND } : {}),
      });
    } catch {
      stopTracks(given);
      dispatch({ type: "refused", why: "unsupported" });
      return;
    }
    chunks.current = [];
    made.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    made.onstop = () => {
      const declared = declaredRecordingType(kind, made.mimeType || mimeType || "");
      const file = new File(chunks.current, recordingFileName(kind, declared), { type: declared });
      stopTracks(stream.current);
      stream.current = null;
      setLive(null);
      const seconds = takeSeconds(kind, stoppedAfter.current, startedAt.current, performance.now());
      dispatch({ type: "recorded", take: { file, seconds, source: "recorder" } });
    };
    made.onerror = () => {
      stopTracks(stream.current);
      dispatch({ type: "refused", why: "failed" });
    };
    recorder.current = made;
    try {
      // Data every second, so a recording stopped by the phone (a call) still has what came before.
      made.start(1000);
    } catch {
      stopTracks(given);
      dispatch({ type: "refused", why: "unsupported" });
      return;
    }
    stoppedAfter.current = null;
    startedAt.current = performance.now();
    dispatch({ type: "started", at: startedAt.current });
  }

  // Asking: the phone's prompt answers; a voice note records at once, a video counts down first.
  useEffect(() => {
    if (state.phase !== "asking") return;
    let current = true;
    const asked = media.current;
    if (!asked) {
      dispatch({ type: "refused", why: "unsupported" });
      return;
    }
    asked.then(
      (given) => {
        if (!current) return;
        stream.current = given;
        setLive(given);
        // A track that ends (the camera taken by a call, unplugged) ends the recording with what it has.
        for (const track of given.getTracks()) {
          track.addEventListener("ended", () => {
            if (recorder.current?.state === "recording") dispatch({ type: "stop", at: performance.now() });
          });
        }
        if (kind === "video") dispatch({ type: "granted" });
        else startRecording();
      },
      (error: unknown) => {
        if (current) dispatch({ type: "refused", why: blockedWhyOf(error) });
      },
    );
    return () => {
      current = false;
    };
    // Once per asking; startRecording reads the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // 3, 2, 1: a second each, then the recording starts.
  const count = state.phase === "countdown" ? state.count : 0;
  useEffect(() => {
    if (state.phase !== "countdown") return;
    const timer = setTimeout(() => (count > 1 ? dispatch({ type: "count" }) : startRecording()), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, count]);

  // Recording: the clock ticks; at the limit the machine stops it.
  useEffect(() => {
    if (state.phase !== "recording") return;
    const timer = setInterval(() => dispatch({ type: "tick", at: performance.now() }), TICK_MILLISECONDS);
    return () => clearInterval(timer);
  }, [state.phase, dispatch]);

  // Stopping: the recorder hands over its last data, then onstop makes the take.
  const stoppingAfter = state.phase === "stopping" ? state.elapsedMs : 0;
  useEffect(() => {
    if (state.phase !== "stopping") return;
    stoppedAfter.current = stoppingAfter;
    const current = recorder.current;
    if (current && current.state !== "inactive") current.stop();
  }, [state.phase, stoppingAfter]);

  // The live front camera, while counting down and recording.
  useEffect(() => {
    if (preview.current && preview.current.srcObject !== live) preview.current.srcObject = live;
  }, [live, state.phase]);

  const stop = () => dispatch({ type: "stop", at: performance.now() });

  switch (state.phase) {
    case "asking":
    case "countdown":
    case "recording":
    case "stopping":
      return kind === "voice" ? (
        <VoiceRecording state={state} onStop={stop} />
      ) : (
        <VideoRecording state={state} onStop={stop} preview={preview} />
      );
    case "review":
      return kind === "voice" ? (
        <VoiceReview take={state.take} onAgain={() => dispatch({ type: "again" })} />
      ) : (
        <VideoReview take={state.take} onAgain={() => dispatch({ type: "again" })} />
      );
    case "blocked":
      return <Blocked kind={kind} problem={state.pickProblem} dispatch={dispatch} />;
    default:
      return null;
  }
}

/** The ring that empties as the recording runs (darker for the last ten seconds), around the stop button. */
function Ring({ kind, state, small, onStop }: { kind: RecordedKind; state: RecorderState; small: boolean; onStop: () => void }) {
  const total = WISH_SECONDS[kind] * 1000;
  const elapsed = state.phase === "recording" || state.phase === "stopping" ? state.elapsedMs : 0;
  const radius = small ? 48 : 62;
  const size = small ? 104 : 132;
  const circumference = 2 * Math.PI * radius;
  const ending = secondsLeft(kind, state) <= 10;
  const recording = state.phase === "recording";
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }} data-ending={ending || undefined}>
      <svg className="pointer-events-none absolute inset-0 -rotate-90" viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={5} className={small ? "stroke-white/25" : "stroke-tray"} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * Math.min(1, elapsed / total)}
          className={`wish-ring-left ${small ? (ending ? "stroke-ember" : "stroke-white") : ending ? "stroke-ember-ink" : "stroke-ember"}`}
        />
      </svg>
      <button
        type="button"
        aria-label="Stop recording"
        disabled={!recording}
        onClick={onStop}
        className={`press relative grid cursor-pointer place-items-center rounded-full disabled:cursor-default ${
          small ? "size-18 bg-ember shadow-[0_6px_16px_rgb(0_0_0/0.3)]" : "size-23 bg-cocoa shadow-[var(--shadow-pill-cocoa)]"
        }`}
      >
        <span className={`rounded-[5px] bg-white ${small ? "size-5.5" : "size-6.5"}`} />
      </button>
    </div>
  );
}

function VoiceRecording({ state, onStop }: { state: RecorderState; onStop: () => void }) {
  if (state.phase === "asking") {
    return (
      <div className="flex flex-col items-center gap-4 pt-5.5 pb-3">
        <span className="flex size-23 items-center justify-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]">
          <Icon name="mic" size={32} />
        </span>
        <p className="m-0 text-center font-serif text-[19px] text-mocha italic" aria-live="polite">
          Allow the microphone to start recording
        </p>
      </div>
    );
  }
  const left = secondsLeft("voice", state);
  return (
    <div className="flex flex-col items-center gap-3.5 pt-4.5 pb-2">
      <Ring kind="voice" state={state} small={false} onStop={onStop} />
      <p className="m-0 flex items-center gap-2.5 text-[15px] font-medium tabular-nums">
        <span className="wish-levels flex h-[18px] items-center gap-[3px]" aria-hidden>
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
        <span>{clockTime(left)} left</span>
      </p>
      <p className="m-0 text-center font-serif text-[19px] text-mocha italic">Recording. Tap to stop.</p>
      <span role="status" className="sr-only">
        {state.phase === "stopping" ? "Recording stopped" : "Recording"}
      </span>
    </div>
  );
}

function VideoRecording({
  state,
  onStop,
  preview,
}: {
  state: RecorderState;
  onStop: () => void;
  preview: RefObject<HTMLVideoElement | null>;
}) {
  const recording = state.phase === "recording" || state.phase === "stopping";
  const elapsed = recording ? Math.floor(state.elapsedMs / 1000) : 0;
  return (
    <div className="relative flex aspect-[4/5] flex-col items-center justify-end gap-3.5 overflow-hidden rounded-[var(--radius-paper)] bg-cocoa pb-6 text-white">
      <video ref={preview} autoPlay muted playsInline aria-hidden className="absolute inset-0 size-full -scale-x-100 object-cover" />
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgb(61_41_39/0)_38%,rgb(61_41_39/0.88))]" />
      <span aria-hidden className="pointer-events-none absolute inset-4.5 rounded-[2px] border border-ember/40" />
      {state.phase === "asking" ? (
        <>
          <p className="relative m-0 px-6 text-center font-serif text-[19px] text-mist italic" aria-live="polite">
            Allow the camera to start
          </p>
          <span aria-hidden className="relative size-18 rounded-full border-4 border-white bg-ember opacity-70" />
        </>
      ) : state.phase === "countdown" ? (
        <>
          <span key={state.count} className="wish-count absolute inset-0 grid place-items-center font-script text-[112px] leading-none text-white" aria-hidden>
            {state.count}
          </span>
          <p className="relative m-0 font-serif text-[19px] text-linen italic" role="status">
            Recording in {state.count}…
          </p>
        </>
      ) : (
        <>
          <p className="absolute top-7.5 left-7.5 m-0 flex items-center gap-2 rounded-full bg-cocoa/70 py-1.5 pr-3 pl-2.5 text-[13px] font-medium tabular-nums">
            <span className="wish-rec-dot size-[9px] rounded-full bg-ember" aria-hidden />
            <span>{clockTime(elapsed)}</span>
          </p>
          <div className="relative">
            <Ring kind="video" state={state} small onStop={onStop} />
          </div>
          <p className="relative m-0 text-sm font-medium text-linen tabular-nums">{clockTime(secondsLeft("video", state))} left</p>
          <span role="status" className="sr-only">
            {state.phase === "stopping" ? "Recording stopped" : "Recording"}
          </span>
        </>
      )}
    </div>
  );
}

/** An object URL of the take's file while it is shown, let go after (take-url.ts). */
function useTakeUrl(file: File): string {
  const url = useMemo(() => takeUrlOf(file), [file]);
  useEffect(() => holdTakeUrl(file), [file]);
  return url;
}

function AgainButton({ onAgain }: { onAgain: () => void }) {
  return (
    <div className="flex justify-center pt-3">
      <button type="button" onClick={onAgain} className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-xs tracking-[0.18em] text-cocoa uppercase">
        <Icon name="retry" size={16} className="text-ember" />
        <span className="border-b border-ember pt-1.5 pb-[3px]">Record again</span>
      </button>
    </div>
  );
}

/** Gate B's listen-back: the guest's own voice note, with a waveform that fills as it plays. */
function VoiceReview({ take, onAgain }: { take: Take; onAgain: () => void }) {
  const url = useTakeUrl(take.file);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [played, setPlayed] = useState(0);
  const length = take.seconds;
  const fraction = length ? Math.min(1, played / length) : 0;

  function toggle() {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  }

  return (
    <div>
      <div className="flex items-center gap-3.5 rounded-full bg-blush py-2.5 pr-5 pl-2.5 shadow-[0_0_0_1px_var(--color-hairline)]">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Listen back"}
          className="press grid size-12 shrink-0 cursor-pointer place-items-center rounded-full bg-ember text-cocoa shadow-[var(--shadow-pill-ember)]"
        >
          {playing ? <PauseGlyph size={18} /> : <PlayGlyph size={18} className="ml-0.5" />}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex h-6 items-center gap-[3px] overflow-hidden" aria-hidden>
            {WAVE_HEIGHTS.map((height, position) => (
              <span
                key={position}
                className={`min-w-[2px] flex-[0_1_3px] rounded-[2px] transition-colors duration-100 ${position / WAVE_HEIGHTS.length < fraction ? "bg-ember" : "bg-mist"}`}
                style={{ height }}
              />
            ))}
          </div>
          <p className="m-0 text-xs text-mocha tabular-nums">
            Your voice note
            {length ? ` · ${playing || played > 0 ? `${clockTime(Math.min(played, length))} of ${clockTime(length)}` : clockTime(length)}` : ""}
          </p>
        </div>
      </div>
      {url ? (
        <audio
          ref={audio}
          src={url}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(event) => setPlayed(event.currentTarget.currentTime)}
          onEnded={() => {
            setPlaying(false);
            setPlayed(0);
          }}
        />
      ) : null}
      <p className="mt-2.5 mb-0 text-center font-serif text-lg text-mocha italic">Listen back, then send it.</p>
      <AgainButton onAgain={onAgain} />
    </div>
  );
}

/** Gate B's watch-back: the recording in the frame, a tap to play or pause it. */
function VideoReview({ take, onAgain }: { take: Take; onAgain: () => void }) {
  const url = useTakeUrl(take.file);
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [unplayable, setUnplayable] = useState(false);

  function toggle() {
    const element = video.current;
    if (!element || unplayable) return;
    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  }

  return (
    <div>
      <div className="relative aspect-[4/5] overflow-hidden rounded-[var(--radius-paper)] bg-cocoa text-white">
        {url ? (
          <video
            ref={video}
            src={`${url}#t=0.1`}
            playsInline
            preload="metadata"
            onClick={toggle}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(event) => {
              const element = event.currentTarget;
              const length = Number.isFinite(element.duration) ? element.duration : (take.seconds ?? 0);
              setProgress(length > 0 ? Math.min(1, element.currentTime / length) : 0);
            }}
            onEnded={() => {
              setPlaying(false);
              setProgress(0);
            }}
            onError={() => setUnplayable(true)}
            className="absolute inset-0 size-full object-contain"
          />
        ) : null}
        <span aria-hidden className="pointer-events-none absolute inset-4.5 rounded-[2px] border border-ember/40" />
        {unplayable ? (
          <p className="absolute inset-x-6 top-1/2 m-0 -translate-y-1/2 text-center font-serif text-xl text-linen italic">
            Your video is ready to send.
          </p>
        ) : (
          <button
            type="button"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Watch it back"}
            className={`press absolute top-[45%] left-1/2 -mt-8 -ml-8 grid size-16 cursor-pointer place-items-center rounded-full bg-white/95 text-cocoa shadow-[0_4px_14px_rgb(61_41_39/0.25)] transition-[opacity,scale] duration-300 ${playing ? "pointer-events-none scale-75 opacity-0" : ""}`}
          >
            <PlayGlyph size={24} className="ml-[3px]" />
          </button>
        )}
        {take.seconds ? (
          <span className="absolute bottom-7.5 left-7.5 flex items-center gap-[5px] rounded-full bg-white/95 py-[3px] pr-2.5 pl-[7px] text-[11px] text-cocoa tabular-nums">
            <PlayGlyph size={9} />
            {clockTime(take.seconds)}
          </span>
        ) : null}
        <span aria-hidden className="absolute inset-x-4.5 bottom-4.5 h-[3px] overflow-hidden rounded-[3px] bg-white/25">
          <span className="block h-full bg-white" style={{ width: `${progress * 100}%` }} />
        </span>
      </div>
      <AgainButton onAgain={onAgain} />
    </div>
  );
}

/** A picked file's length, as the phone's own media element reads it; null when it can't say in time. */
function lengthOf(file: File, kind: RecordedKind): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement(kind === "voice" ? "audio" : "video");
    const url = URL.createObjectURL(file);
    const done = (seconds: number | null) => {
      clearTimeout(timer);
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => done(null), LENGTH_READ_MILLISECONDS);
    element.preload = "metadata";
    element.onloadedmetadata = () => done(Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null);
    element.onerror = () => done(null);
    element.src = url;
  });
}

/**
 * Gate B 4d: the browser won't let us record, so the phone's own camera or recorder takes over
 * through a file input with `capture`, and what it records comes back here to send, like any
 * other. Anything longer than the limit is trimmed by the worker, as the card says up front.
 */
function Blocked({ kind, problem, dispatch }: { kind: RecordedKind; problem: string | null; dispatch: Dispatch<RecorderEvent> }) {
  const [copied, setCopied] = useState(false);
  const voice = kind === "voice";

  async function picked(file: File | undefined) {
    if (!file) return;
    const contentType = declaredType(file);
    const family = voice ? "audio/" : "video/";
    const checked = checkUpload({ purpose: "wish", filename: file.name, contentType, size: file.size });
    if (!checked.ok || !contentType.startsWith(family)) {
      // A file of the other kind, or of a type a wish doesn't take (a FLAC, a 3GP named as video):
      // said plainly, with what to choose instead; over its size or empty, the upload API's words.
      const wrongKind = checked.ok || checked.error === "unsupported-type";
      dispatch({
        type: "pickRefused",
        problem: wrongKind
          ? voice
            ? "We can't take that kind of file. Please choose a recording from your recorder."
            : "We can't take that kind of file. Please record a video with your camera."
          : checked.message,
      });
      return;
    }
    dispatch({ type: "picked", take: { file, seconds: await lengthOf(file, kind), source: "picker" } });
  }

  return (
    <div className="flex flex-col gap-3.5 rounded-[var(--radius-paper)] bg-cocoa px-5 py-5.5 text-white">
      <div className="flex items-start gap-3.5">
        <Halo icon={voice ? "mic-off" : "camera-off"} tone="dark" size="md" />
        <div className="min-w-0">
          <p className="m-0 font-serif text-[23px] leading-[1.18] text-balance italic">
            Your browser won&apos;t let us use the {voice ? "microphone" : "camera"} here.
          </p>
          <p className="mt-1.5 mb-0 text-sm leading-normal text-linen">
            {voice
              ? "Record with your phone's voice recorder instead. Keep it under a minute; anything longer is trimmed."
              : "Record with your phone's camera instead. Keep it under 30 seconds; anything longer is trimmed."}
          </p>
        </div>
      </div>
      <label className="press relative flex min-h-14 cursor-pointer items-center justify-center gap-3 rounded-full bg-ember py-1 pr-5.5 pl-1.5 text-xs font-medium tracking-[0.16em] text-cocoa uppercase shadow-[var(--shadow-pill-dark)] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-3 has-[:focus-visible]:outline-ember">
        <Halo icon={voice ? "mic" : "camera"} tone="glass" size="md" />
        {voice ? "Open my recorder" : "Open my camera"}
        <input
          type="file"
          accept={voice ? "audio/*" : "video/*"}
          capture={voice ? true : "user"}
          className="sr-only"
          onChange={(event) => {
            void picked(event.currentTarget.files?.[0]);
            event.currentTarget.value = "";
          }}
        />
      </label>
      {problem ? (
        <p role="alert" className="m-0 text-sm text-linen">
          {problem}
        </p>
      ) : null}
      <p className="m-0 text-[12.5px] leading-normal text-mist">
        Or open this page in Chrome or Safari to record here.{" "}
        <button
          type="button"
          onClick={async () => setCopied(await copyText(window.location.href))}
          className="ml-0.5 min-h-8 cursor-pointer border-b border-ember p-0 text-[12.5px] text-white"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
      </p>
    </div>
  );
}
