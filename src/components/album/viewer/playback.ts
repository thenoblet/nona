import { conversionFailureWords, type AlbumVideo } from "@/lib/media/album-item";

/*
 * Which version of a video the viewer plays (the controller's order, 31 Oct, replacing the
 * brief's). A video's original is never played: it carries the place it was filmed, and the worker
 * makes a clean copy of every video instead (derived.playable), and an H.264 conversion of those
 * not every phone plays (derived.video).
 */

/** H.264 High at level 4.2: what every phone plays, and what the conversion and an H.264 copy are. */
export const H264_TYPE = 'video/mp4; codecs="avc1.64002A"';
/**
 * HEVC in an hvc1-tagged MP4 (the copy's tag), Main 10 at level 5.1: an iPhone's HDR video. A phone
 * that says "probably" to it plays an iPhone's SDR HEVC (Main) as well.
 */
export const HEVC_MAIN10_TYPE = 'video/mp4; codecs="hvc1.2.4.L153.B0"';

export type PlaybackChoice =
  /** The H.264 conversion. */
  | { kind: "converted"; url: string }
  /** The clean copy, which this phone plays. */
  | { kind: "copy"; url: string }
  /**
   * The poster, with "Preparing a version for your phone…". `ask`: ask for the conversion now
   * (POST /playable); otherwise a copy this phone plays is on its way, and the viewer waits for it.
   */
  | { kind: "preparing"; ask: boolean }
  /** No version this phone plays will come: its conversion failed for good. */
  | { kind: "failed"; words: string };

/** Whether this phone plays the video's clean copy: H.264 always; HEVC only on a "probably" for Main 10. */
function copyPlaysHere(codec: string | null, canPlayType: (type: string) => string): boolean {
  if (codec === "h264") return true;
  return codec === "hevc" && canPlayType(HEVC_MAIN10_TYPE) === "probably";
}

/**
 * The version to play, in order:
 * 1. the converted H.264, when it exists;
 * 2. else the clean copy, when this phone plays it;
 * 3. else the poster and "Preparing…": asking for the conversion, unless a copy this phone will
 *    play is on its way (an H.264 or HEVC video whose copy the worker hasn't finished), or saying
 *    that none will come when the conversion failed for good.
 */
export function choosePlayback(video: AlbumVideo, canPlayType: (type: string) => string): PlaybackChoice {
  if (video.converted) return { kind: "converted", url: video.converted };
  const playsHere = copyPlaysHere(video.codec, canPlayType);
  if (video.copy && playsHere) return { kind: "copy", url: video.copy };
  if (video.conversion === "failed") return { kind: "failed", words: conversionFailureWords(video.conversionFailure) };
  return { kind: "preparing", ask: !(playsHere && !video.copy) };
}
