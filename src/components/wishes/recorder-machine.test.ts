import { describe, expect, it } from "vitest";
import { blockedWhyOf, IDLE, isBusy, secondsLeft, transition, type RecorderEvent, type RecorderState, type Take } from "./recorder-machine";
import {
  declaredRecordingType,
  mediaConstraints,
  pickRecordingType,
  recordingFileName,
  type RecordedKind,
} from "./recording";

/*
 * The voice and video recorder (gate B 4a–4d, Rulings BT and BU), apart from the browser: its
 * states, its clock, the type it records, and what it asks the phone for.
 */

const take = (source: Take["source"] = "recorder"): Take => ({
  file: new File([new Uint8Array(16)], "voice-wish.webm", { type: "audio/webm" }),
  seconds: 19,
  source,
});

/** Runs the events through the machine from idle, and returns every state it passed through. */
function run(kind: RecordedKind, events: RecorderEvent[], from: RecorderState = IDLE): RecorderState[] {
  const states = [from];
  for (const event of events) states.push(transition(kind, states.at(-1) as RecorderState, event));
  return states;
}

describe("the recorder's states", () => {
  it("runs a voice note idle → asking → recording (time left) → stopped → listening → re-record → sending → sent", () => {
    const recorded = take();
    const phases = run("voice", [
      { type: "tap" },
      { type: "started", at: 1_000 },
      { type: "tick", at: 20_000 },
      { type: "stop", at: 20_500 },
      { type: "recorded", take: recorded },
      { type: "again" },
      { type: "tap" },
      { type: "started", at: 30_000 },
      { type: "stop", at: 40_000 },
      { type: "recorded", take: recorded },
      { type: "send" },
      { type: "sent", wishId: "wish-1", signedAs: "Ama" },
      { type: "another" },
    ]).map((state) => state.phase);

    expect(phases).toEqual([
      "idle",
      "asking",
      "recording",
      "recording",
      "stopping",
      "review",
      "idle",
      "asking",
      "recording",
      "stopping",
      "review",
      "sending",
      "sent",
      "idle",
    ]);
  });

  it("counts the time left as gate B's ring shows it: 0:41 left 19 s into a voice note, 0:18 left 12 s into a video", () => {
    const voice = run("voice", [{ type: "tap" }, { type: "started", at: 0 }, { type: "tick", at: 19_000 }]).at(-1) as RecorderState;
    expect(voice).toEqual({ phase: "recording", startedAt: 0, elapsedMs: 19_000 });
    expect(secondsLeft("voice", voice)).toBe(41);
    expect(secondsLeft("voice", run("voice", [{ type: "tap" }, { type: "started", at: 0 }, { type: "tick", at: 18_200 }]).at(-1) as RecorderState)).toBe(42);
    const video = run("video", [{ type: "tap" }, { type: "granted" }, { type: "started", at: 5_000 }, { type: "tick", at: 17_000 }]).at(-1) as RecorderState;
    expect(secondsLeft("video", video)).toBe(18);
    expect(secondsLeft("voice", IDLE)).toBe(60);
  });

  it("stops a voice note by itself at 60 s, and a video message at 30 s", () => {
    const voice = run("voice", [{ type: "tap" }, { type: "started", at: 0 }, { type: "tick", at: 59_900 }, { type: "tick", at: 60_000 }]);
    expect(voice.at(-2)).toMatchObject({ phase: "recording", elapsedMs: 59_900 });
    expect(voice.at(-1)).toEqual({ phase: "stopping", elapsedMs: 60_000 });
    expect(secondsLeft("voice", voice.at(-1) as RecorderState)).toBe(0);

    const video = run("video", [{ type: "tap" }, { type: "granted" }, { type: "started", at: 0 }, { type: "tick", at: 29_999 }, { type: "tick", at: 31_000 }]);
    expect(video.at(-2)).toMatchObject({ phase: "recording" });
    // Never counted past the limit, however late the tick.
    expect(video.at(-1)).toEqual({ phase: "stopping", elapsedMs: 30_000 });
  });

  it("counts a video message down 3, 2, 1 over the camera before it records", () => {
    const states = run("video", [{ type: "tap" }, { type: "granted" }, { type: "count" }, { type: "count" }, { type: "count" }, { type: "started", at: 9 }]);
    expect(states.map((state) => (state.phase === "countdown" ? state.count : state.phase))).toEqual([
      "idle",
      "asking",
      3,
      2,
      1,
      1,
      "recording",
    ]);
    // A voice note has no countdown: granted, it waits for the recorder to start.
    expect(transition("voice", { phase: "asking" }, { type: "granted" })).toEqual({ phase: "asking" });
  });

  it("hands over to the phone's own camera or recorder when getUserMedia is refused, and takes what it records", () => {
    const blocked = run("video", [{ type: "tap" }, { type: "refused", why: "refused" }]).at(-1) as RecorderState;
    expect(blocked).toEqual({ phase: "blocked", why: "refused", pickProblem: null });

    const refusedPick = transition("video", blocked, { type: "pickRefused", problem: "This video message is over 400 MB, the most a wish takes." });
    expect(refusedPick).toMatchObject({ phase: "blocked", pickProblem: expect.stringContaining("400 MB") });

    const picked = take("picker");
    const review = transition("video", refusedPick, { type: "picked", take: picked });
    expect(review).toEqual({ phase: "review", take: picked });
    // Recording again from the phone's own camera opens the fallback again, not the recorder.
    expect(transition("video", review, { type: "again" })).toMatchObject({ phase: "blocked" });
    // The camera failing mid-recording does the same.
    expect(transition("video", { phase: "recording", startedAt: 0, elapsedMs: 0 }, { type: "refused", why: "failed" })).toMatchObject({
      phase: "blocked",
      why: "failed",
    });
  });

  it("keeps the take when a send fails, so it can be sent again without recording again", () => {
    const recorded = take();
    expect(transition("voice", { phase: "sending", take: recorded }, { type: "sendFailed" })).toEqual({ phase: "review", take: recorded });
  });

  it("keeps a take the browser handed over while still recording (it stopped the recorder itself)", () => {
    const recorded = take();
    expect(transition("video", { phase: "recording", startedAt: 0, elapsedMs: 4_000 }, { type: "recorded", take: recorded })).toEqual({
      phase: "review",
      take: recorded,
    });
  });

  it("ignores events that don't belong where they arrive, and is reset from anywhere", () => {
    const recording: RecorderState = { phase: "recording", startedAt: 0, elapsedMs: 1_000 };
    for (const event of [{ type: "tap" }, { type: "send" }, { type: "another" }, { type: "pickRefused", problem: "No" }] as RecorderEvent[]) {
      expect(transition("voice", recording, event), event.type).toBe(recording);
    }
    expect(transition("voice", IDLE, { type: "tick", at: 5 })).toBe(IDLE);
    expect(transition("voice", { phase: "review", take: take() }, { type: "tick", at: 5 })).toMatchObject({ phase: "review" });
    expect(transition("voice", recording, { type: "reset" })).toEqual(IDLE);
  });

  it("holds the composer while it asks, counts down, records or stops, and not otherwise", () => {
    const busy: RecorderState[] = [{ phase: "asking" }, { phase: "countdown", count: 2 }, { phase: "recording", startedAt: 0, elapsedMs: 0 }, { phase: "stopping", elapsedMs: 3 }];
    for (const state of busy) expect(isBusy(state), state.phase).toBe(true);
    for (const state of [IDLE, { phase: "review", take: take() }, { phase: "blocked", why: "refused", pickProblem: null }] as RecorderState[]) {
      expect(isBusy(state), state.phase).toBe(false);
    }
  });

  it("reads a getUserMedia refusal: no camera API at all is unsupported, anything else refused", () => {
    expect(blockedWhyOf(new DOMException("denied", "NotAllowedError"))).toBe("refused");
    expect(blockedWhyOf(new DOMException("no camera", "NotFoundError"))).toBe("refused");
    expect(blockedWhyOf(new DOMException("no API", "NotSupportedError"))).toBe("unsupported");
    expect(blockedWhyOf(new TypeError("navigator.mediaDevices is undefined"))).toBe("unsupported");
  });
});

describe("the type it records (Ruling BT)", () => {
  const supports = (...types: string[]) => (type: string) => types.includes(type);

  it("takes WebM with Opus first, VP8 before VP9 for video, and MP4 where that is all there is (Safari)", () => {
    expect(pickRecordingType("voice", supports("audio/webm;codecs=opus", "audio/webm", "audio/mp4"))).toBe("audio/webm;codecs=opus");
    expect(pickRecordingType("voice", supports("audio/mp4"))).toBe("audio/mp4");
    expect(pickRecordingType("video", supports("video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/mp4"))).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(pickRecordingType("video", supports("video/webm;codecs=vp9,opus", "video/mp4"))).toBe("video/webm;codecs=vp9,opus");
    expect(pickRecordingType("video", supports("video/mp4"))).toBe("video/mp4");
  });

  it("finds none in a browser that records nothing we take, or throws asking", () => {
    expect(pickRecordingType("video", supports("video/x-matroska"))).toBeNull();
    expect(
      pickRecordingType("voice", () => {
        throw new Error("not implemented");
      }),
    ).toBeNull();
  });

  it("declares a voice note as audio whatever the browser called it, and names the file by its type", () => {
    expect(declaredRecordingType("voice", "audio/webm;codecs=opus")).toBe("audio/webm");
    expect(declaredRecordingType("voice", "video/webm")).toBe("audio/webm");
    expect(declaredRecordingType("voice", "audio/mp4")).toBe("audio/mp4");
    expect(declaredRecordingType("video", "video/webm;codecs=vp8,opus")).toBe("video/webm");
    expect(declaredRecordingType("video", "")).toBe("video/webm");
    expect(recordingFileName("voice", "audio/mp4")).toBe("voice-wish.m4a");
    expect(recordingFileName("voice", "audio/webm")).toBe("voice-wish.webm");
    expect(recordingFileName("video", "video/mp4")).toBe("video-wish.mp4");
  });

  it("asks for the front camera at an ideal 1280 × 720 with sound, and the microphone alone for a voice note", () => {
    expect(mediaConstraints("video")).toEqual({ audio: true, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } });
    expect(mediaConstraints("voice")).toEqual({ audio: true });
  });
});
