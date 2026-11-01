/*
 * How a wish is recorded in the browser (Ruling BT), shared by the recorder's light first-load part
 * (which asks for the camera or microphone on the first tap) and its lazily loaded panel. Small and
 * framework-free, so it costs the wishes page next to nothing.
 */

export type RecordedKind = "voice" | "video";

/** A video message counts down before it records, so the guest can settle in front of the camera. */
export const COUNTDOWN_FROM = 3;

/**
 * Ruling BT: about 2.5 Mbit/s of video and 96 kbit/s of sound, so a 30 s video wish is about 10 MB
 * on mobile data (the worker makes it 720p H.264 anyway), and a minute's voice note under 1 MB.
 */
export const VIDEO_BITS_PER_SECOND = 2_500_000;
export const AUDIO_BITS_PER_SECOND = 96_000;

/**
 * What getUserMedia is asked for: the microphone for a voice note; the front camera at an ideal
 * 1280 × 720 (the phone gives its nearest) with the microphone for a video message (Ruling BT).
 */
export function mediaConstraints(kind: RecordedKind): MediaStreamConstraints {
  if (kind === "voice") return { audio: true };
  return { audio: true, video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } };
}

/**
 * The types MediaRecorder is offered, in order: WebM with Opus first (Chrome, Firefox, Android),
 * else MP4 (Safari). A video message prefers VP8, which phones encode cheaply (often in hardware),
 * to VP9.
 */
const PREFERRED_TYPES: Record<RecordedKind, readonly string[]> = {
  voice: ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"],
  video: ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm", "video/mp4"],
};

/**
 * The first type this browser's MediaRecorder says it can record, or null when it can record none
 * (the recorder then hands over to the phone's own camera or recorder).
 */
export function pickRecordingType(kind: RecordedKind, isTypeSupported: (type: string) => boolean): string | null {
  for (const type of PREFERRED_TYPES[kind]) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      // An old browser that throws for a type it doesn't know: try the next.
    }
  }
  return null;
}

/**
 * The type a recording is declared as for its upload: the recorder's own, without its codecs (the
 * upload API compares the bare type), and audio for a voice note whatever the browser called it
 * (some name an audio-only WebM `video/webm`), so a voice wish is always the upload API's audio.
 */
export function declaredRecordingType(kind: RecordedKind, recorderType: string): string {
  const bare = recorderType.split(";")[0].trim().toLowerCase();
  if (kind === "voice") return bare.replace(/^video\//, "audio/") || "audio/webm";
  return bare || "video/webm";
}

/** The file name a recording is sent with, by its type: what the upload API takes the extension from. */
export function recordingFileName(kind: RecordedKind, declaredType: string): string {
  const extension = declaredType.endsWith("/mp4") ? (kind === "voice" ? "m4a" : "mp4") : declaredType.endsWith("/ogg") ? "ogg" : "webm";
  return `${kind === "voice" ? "voice-wish" : "video-wish"}.${extension}`;
}
