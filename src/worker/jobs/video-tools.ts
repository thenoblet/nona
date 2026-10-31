import { ProcessError, type ProcessOutput, type RedactedLink } from "../processes";
import { PermanentJobError } from "../queues";
import { describeEnding, killedFromOutside, runCapped, toolDidNotRun } from "./capped-tools";
import { PROBE_ENTRIES, VIDEO_DEMUXERS, videoFactsFrom, type VideoFacts } from "./video-probe";

/*
 * What every video job (a poster, a conversion, a video wish) does with ffprobe and ffmpeg: runs
 * them under a memory cap, reads ffprobe's description of a video, and tells their failures apart,
 * the file's fault (for good, once it has failed the same way on three attempts) from the worker's
 * or the network's (tried again).
 */

/**
 * From this attempt on (pg-boss's retryCount: the third attempt), a failure that looks like the
 * file's is taken to be: a stalled read, or a worker short of something, wouldn't fail the same way
 * three times, minutes apart (Ruling AO).
 */
const FILE_BLAMED_FROM_RETRY = 2;
/**
 * How much ffprobe and ffmpeg read to find the streams' details: ffmpeg's own defaults, stated so a
 * change of default can't move them. They bound only that probing, not the container's index (a
 * crafted MOV's whole `moov` is read whatever they say); what bounds a crafted file is the memory
 * cap, the time limits and the two whitelists (ffmpeg notes §4.5).
 */
const PROBE_BYTES = 5_000_000;
const PROBE_MICROSECONDS = 5_000_000;

/** How a tool opens the original: what it may read it through (a link, or a scratch file), and as what. */
export type ReadingArgs = string[];

/**
 * As one of the two video demuxers only (MOV/MP4/3GP and Matroska/WebM), probing no more than
 * ffmpeg's defaults: what every read of an original adds to how it reaches it.
 */
export const VIDEO_READING_LIMITS = [
  ...["-format_whitelist", VIDEO_DEMUXERS],
  ...["-probesize", String(PROBE_BYTES)],
  ...["-analyzeduration", String(PROBE_MICROSECONDS)],
];

/**
 * How ffprobe and ffmpeg open an original in the job's scratch folder: as a file and nothing else,
 * so the file can't make them open anything (ffmpeg notes §2.0, §2.3).
 */
export const SCRATCH_FILE_READING: ReadingArgs = ["-protocol_whitelist", "file", ...VIDEO_READING_LIMITS];

/** ffmpeg's options before any input in every video job (ffmpeg notes §2.0). */
export function ffmpegGlobalArgs(filterThreads: number): string[] {
  // -loglevel error: at the default level ffmpeg lists the file's metadata, location included.
  // -xerror: the first read or decode error fails the run, rather than ending the input as if it
  // were the file's end and exiting 0 with a short output (ffmpeg notes §4.17). -filter_threads:
  // the filters' threads, which would otherwise be the host's CPUs, not the container's (§4.14).
  return [
    ...["-hide_banner", "-loglevel", "error", "-nostdin", "-nostats", "-xerror", "-y"],
    ...["-filter_threads", String(filterThreads)],
  ];
}

/** Where and how a video job runs ffprobe and ffmpeg. */
export type VideoToolRun = {
  /** The most address space the tool may take (prlimit --as). */
  memoryBytes: number;
  /** The job's signal: aborting it kills the tool. */
  signal: AbortSignal;
  /** The job's scratch folder, the tool's working folder. */
  folder: string;
  /** The job's retries so far: a failure that looks like the file's is blamed on it from the third attempt. */
  retryCount: number;
  /** `background` (nice 19) for a conversion; a poster runs at the worker's own priority, as a guest waits for it. */
  priority: "background" | "foreground";
  /**
   * Where the original is read from. Over the link, a stall can look like a damaged file; from the
   * scratch folder, a failure that looks like the file's is still retried twice, as the worker
   * (its disk, its memory) can fail the same way.
   */
  source: "link" | "scratch";
  /** A presigned link among the arguments, kept out of what the tool prints. */
  redact?: RedactedLink;
};

type FailureContext = Pick<VideoToolRun, "memoryBytes" | "retryCount"> & { source?: VideoToolRun["source"] };

// Something between the tool and R2 failed, not the file: a protocol layer complained (ffmpeg
// names it in its log line), R2 answered with an HTTP error, or the connection was refused, reset,
// cut short, timed out or never made (DNS). ffmpeg sees the network through avio, whose errors end
// as "Input/output error", as a failing disk's do.
const NETWORK_TROUBLE = new RegExp(
  [
    "^\\[(?:tcp|tls|http|https) @",
    "Server returned",
    "HTTP error",
    "Connection refused",
    "Connection reset",
    "Connection timed out",
    "Operation timed out",
    "Failed to resolve hostname",
    "Network is unreachable",
    "No route to host",
    "Input/output error",
    "Broken pipe",
    "Stream ends prematurely",
    "Error in the pull function",
  ].join("|"),
  "m",
);
// A thread the tool couldn't start (EAGAIN): the worker's limits on threads or memory, not the file.
const NO_THREAD = /pthread_create|Resource temporarily unavailable/;
// The scratch disk filled up (ENOSPC) while the tool wrote: other jobs' files, not this one's.
const NO_SPACE = /No space left on device/;
// The tool refused one of its own options: the image's ffmpeg isn't the 7.1 the job was written
// for (ffmpeg 4.4 has no -reconnect_max_retries). The worker's build, never the file (Ruling AP).
const UNKNOWN_OPTION = /Option not found|Unrecognized option/;
// What ffmpeg says when it recognised the file as a format other than the two it may open.
const NOT_ALLOWED_FORMAT = /Format not on whitelist/;

/** The last line a tool printed (runProcess has already taken any link out). */
function lastLineOf(stderr: string): string {
  return stderr.trim().split("\n").at(-1) ?? "";
}

/**
 * A failure that looks like the file's: from the third attempt it is, `corrupt`, for good. Before
 * that it is retried: over the network a stalled read fails the same way (ffmpeg notes §4.4), and
 * from scratch the worker's own disk or memory can.
 */
export function blameFileFromThirdAttempt(message: string, retryCount: number, source: VideoToolRun["source"] = "link"): Error {
  if (retryCount >= FILE_BLAMED_FROM_RETRY) return new PermanentJobError("corrupt", message);
  const why = source === "link" ? "a stalled read from R2 looks the same" : "the file is blamed from its third attempt";
  return new Error(`${message} (tried again: ${why})`);
}

/**
 * What ffprobe or ffmpeg failing on an original means. Every error it returns is new, with no
 * cause; what the tool printed comes from runProcess with any link already taken out.
 * - `unsupported-type` at once: ffmpeg recognised a format other than the two allowed.
 * - Retried, always: R2, the network or the disk failed a read; a thread couldn't start (EAGAIN);
 *   the scratch disk was full; a SIGKILL from outside (the OOM killer); the tool ran past its time
 *   (a slow read, or a busy box, can't be told from a slow file); the job ended; the worker
 *   stopped; the tool couldn't run, or didn't know one of its options (an image built with another
 *   ffmpeg).
 * - Anything else looks like the file's fault (the tool refused it, died on it, ran out of memory
 *   under the cap, or printed far too much): retried twice, then `corrupt`.
 * Exported for its test.
 */
export function videoToolFailure(tool: "ffprobe" | "ffmpeg", error: unknown, context: FailureContext): Error {
  const source = context.source ?? "link";
  if (!(error instanceof ProcessError)) {
    const code = (error as { code?: unknown } | null)?.code;
    const name = error instanceof Error ? error.name : "an unknown error";
    return new Error(`${tool} couldn't run: ${name}${typeof code === "string" ? ` (${code})` : ""}`);
  }
  const lastLine = lastLineOf(error.stderrTail);
  const ending = describeEnding(error);
  if (error.ending === "too-much-output") {
    return blameFileFromThirdAttempt(`${tool} printed far too much reading the video: ${ending}`, context.retryCount, source);
  }
  if (error.ending !== "exit") return new Error(`${tool} didn't finish with the video: ${ending}`);
  if (toolDidNotRun(error)) return new Error(`${tool} couldn't run: ${ending}: ${lastLine}`);
  if (UNKNOWN_OPTION.test(error.stderrTail)) {
    return new Error(`${tool} doesn't know an option the worker gave it (is it ffmpeg 7.1?): ${ending}: ${lastLine}`);
  }
  if (killedFromOutside(error)) return new Error(`${tool} was killed from outside the worker: ${ending}`);
  if (error.exitCode !== null && NOT_ALLOWED_FORMAT.test(error.stderrTail)) {
    const refusal = error.stderrTail.split("\n").find((line) => NOT_ALLOWED_FORMAT.test(line)) ?? lastLine;
    return new PermanentJobError("unsupported-type", `The original isn't a video the album takes: ${refusal.trim()}`);
  }
  if (error.exitCode !== null && NETWORK_TROUBLE.test(error.stderrTail)) {
    const what = source === "link" ? "read the original from R2" : "read or write its files on the scratch disk";
    return new Error(`${tool} couldn't ${what}: ${ending}: ${lastLine}`);
  }
  if (NO_SPACE.test(error.stderrTail)) return new Error(`${tool} ran out of scratch space: ${ending}: ${lastLine}`);
  if (NO_THREAD.test(error.stderrTail)) {
    return new Error(`${tool} couldn't start its threads, under a ${context.memoryBytes}-byte cap: ${ending}: ${lastLine}`);
  }
  return blameFileFromThirdAttempt(
    `${tool} couldn't read the video, under a ${context.memoryBytes}-byte cap: ${ending}: ${lastLine}`,
    context.retryCount,
    source,
  );
}

/** Runs ffprobe or ffmpeg under the memory cap (runCapped), any link kept out of what it prints, its failure told apart by videoToolFailure. */
export async function runVideoTool(
  tool: "ffprobe" | "ffmpeg",
  args: string[],
  run: VideoToolRun,
  timeoutMilliseconds: number,
): Promise<ProcessOutput> {
  try {
    return await runCapped(tool, args, {
      memoryBytes: run.memoryBytes,
      signal: run.signal,
      timeoutMilliseconds,
      priority: run.priority,
      cwd: run.folder,
      redact: run.redact,
    });
  } catch (error) {
    throw videoToolFailure(tool, error, run);
  }
}

/**
 * ffprobe's description of the original at `input`, opened by `reading`, checked: a video the album
 * takes (layer 3), and its facts. Only PROBE_ENTRIES are printed, so no location is ever read.
 */
export async function probeVideo(
  reading: ReadingArgs,
  input: string,
  run: VideoToolRun,
  timeoutMilliseconds: number,
): Promise<VideoFacts> {
  const args = ["-hide_banner", "-loglevel", "error", ...reading];
  args.push("-print_format", "json", "-show_error", "-show_entries", PROBE_ENTRIES, input);
  const { stdout } = await runVideoTool("ffprobe", args, run, timeoutMilliseconds);
  let description: unknown;
  try {
    description = JSON.parse(stdout);
  } catch {
    throw blameFileFromThirdAttempt("ffprobe's description of the original isn't JSON", run.retryCount, run.source);
  }
  // What ffprobe read is the container's own header: no stall makes it describe another file, so
  // its refusals stand at once.
  const check = videoFactsFrom(description);
  if (!check.ok) throw new PermanentJobError(check.reason, `The original is ${check.found}, not a video the album takes`);
  return check.facts;
}
