import { WISH_SECONDS } from "@/lib/media/wish-seconds";
import { COUNTDOWN_FROM, type RecordedKind } from "./recording";

/*
 * The voice and video recorder's states (gate B, 4a–4d), as a pure transition function the
 * composer keeps in a reducer, so every step is tested apart from the browser:
 *
 *   idle ─tap→ asking ─(voice: started)→ recording ─stop or the limit→ stopping ─recorded→ review
 *                                          recording ─recorded→ review   (the browser stopped it itself)
 *                     ─(video: granted)→ countdown 3, 2, 1 ─started→ recording
 *                     ─refused→ blocked ─picked→ review   (the phone's own camera or recorder)
 *   review ─again→ idle (or blocked, for a take from the phone's own camera)
 *   review ─send→ sending ─sent→ sent ─another→ idle;  sending ─sendFailed→ review
 *
 * An event that doesn't belong to the state it arrives in (a late tick, a second tap) changes
 * nothing.
 */

/** Why the recorder hands over to the phone's own camera or recorder. */
export type BlockedWhy =
  /** The browser or the guest refused the camera or microphone (getUserMedia's NotAllowedError, an in-app browser). */
  | "refused"
  /** The browser has no getUserMedia or MediaRecorder, or records no type we take. */
  | "unsupported"
  /** The camera or microphone failed while recording (taken by another app, unplugged). */
  | "failed";

/** One recording, ready to listen to or watch back and send. */
export type Take = {
  file: File;
  /** Its length as the recorder's clock measured it, or as the phone read a picked file; null when unknown. */
  seconds: number | null;
  /** This page's recorder, or the phone's own camera or recorder (the fallback's file input). */
  source: "recorder" | "picker";
};

export type RecorderState =
  | { phase: "idle" }
  /** getUserMedia asked: the phone shows its own prompt. */
  | { phase: "asking" }
  /** A video message's 3, 2, 1, over the live front camera. */
  | { phase: "countdown"; count: number }
  | { phase: "recording"; startedAt: number; elapsedMs: number }
  /** Stopped (by the guest, or at the limit), waiting for the recorder's last data. */
  | { phase: "stopping"; elapsedMs: number }
  | { phase: "review"; take: Take }
  | { phase: "blocked"; why: BlockedWhy; pickProblem: string | null }
  | { phase: "sending"; take: Take }
  | { phase: "sent"; wishId: string; signedAs: string };

export type RecorderEvent =
  | { type: "tap" }
  | { type: "granted" }
  | { type: "refused"; why: BlockedWhy }
  | { type: "count" }
  | { type: "started"; at: number }
  | { type: "tick"; at: number }
  | { type: "stop"; at: number }
  | { type: "recorded"; take: Take }
  | { type: "again" }
  | { type: "picked"; take: Take }
  | { type: "pickRefused"; problem: string }
  | { type: "send" }
  | { type: "sendFailed" }
  | { type: "sent"; wishId: string; signedAs: string }
  | { type: "another" }
  | { type: "reset" };

export const IDLE: RecorderState = { phase: "idle" };

/** The most a recording of this kind runs, in milliseconds: the limit the worker trims to (WISH_SECONDS). */
function limitMs(kind: RecordedKind): number {
  return WISH_SECONDS[kind] * 1000;
}

/** The recorder's next state. Pure: what to do in the browser follows from the state it returns. */
export function transition(kind: RecordedKind, state: RecorderState, event: RecorderEvent): RecorderState {
  if (event.type === "reset") return IDLE;
  switch (state.phase) {
    case "idle":
      return event.type === "tap" ? { phase: "asking" } : state;
    case "asking":
      if (event.type === "refused") return { phase: "blocked", why: event.why, pickProblem: null };
      if (event.type === "granted" && kind === "video") return { phase: "countdown", count: COUNTDOWN_FROM };
      if (event.type === "started") return { phase: "recording", startedAt: event.at, elapsedMs: 0 };
      return state;
    case "countdown":
      if (event.type === "count") return { phase: "countdown", count: Math.max(1, state.count - 1) };
      if (event.type === "started") return { phase: "recording", startedAt: event.at, elapsedMs: 0 };
      if (event.type === "refused") return { phase: "blocked", why: event.why, pickProblem: null };
      return state;
    case "recording": {
      if (event.type === "refused") return { phase: "blocked", why: event.why, pickProblem: null };
      // The browser stopped the recorder itself (its track ended) before the machine heard a stop:
      // the take it handed over is kept, never dropped.
      if (event.type === "recorded") return { phase: "review", take: event.take };
      if (event.type !== "tick" && event.type !== "stop") return state;
      const elapsedMs = Math.min(Math.max(0, event.at - state.startedAt), limitMs(kind));
      // At the limit it stops itself, as gate B's ring runs out.
      if (event.type === "stop" || elapsedMs >= limitMs(kind)) return { phase: "stopping", elapsedMs };
      return { ...state, elapsedMs };
    }
    case "stopping":
      if (event.type === "recorded") return { phase: "review", take: event.take };
      if (event.type === "refused") return { phase: "blocked", why: event.why, pickProblem: null };
      return state;
    case "review":
      if (event.type === "send") return { phase: "sending", take: state.take };
      if (event.type === "again") return state.take.source === "picker" ? { phase: "blocked", why: "refused", pickProblem: null } : IDLE;
      return state;
    case "blocked":
      if (event.type === "picked") return { phase: "review", take: event.take };
      if (event.type === "pickRefused") return { ...state, pickProblem: event.problem };
      return state;
    case "sending":
      if (event.type === "sent") return { phase: "sent", wishId: event.wishId, signedAs: event.signedAs };
      if (event.type === "sendFailed") return { phase: "review", take: state.take };
      return state;
    case "sent":
      return event.type === "another" ? IDLE : state;
  }
}

/** Whole seconds left while recording, as the ring's "0:41 left" counts them; the limit otherwise. */
export function secondsLeft(kind: RecordedKind, state: RecorderState): number {
  const limit = WISH_SECONDS[kind];
  if (state.phase === "stopping") return Math.max(0, Math.ceil(limit - state.elapsedMs / 1000));
  if (state.phase !== "recording") return limit;
  return Math.max(0, Math.ceil(limit - state.elapsedMs / 1000));
}

/** Whether the recorder holds the composer (its tabs and Send wait): asking, counting down, recording or stopping. */
export function isBusy(state: RecorderState): boolean {
  return state.phase === "asking" || state.phase === "countdown" || state.phase === "recording" || state.phase === "stopping";
}

/** The browser's getUserMedia refusal, in the recorder's terms: unsupported for no camera API at all, refused otherwise. */
export function blockedWhyOf(error: unknown): BlockedWhy {
  const name = error instanceof Error || error instanceof DOMException ? error.name : "";
  return name === "NotSupportedError" || name === "TypeError" ? "unsupported" : "refused";
}
