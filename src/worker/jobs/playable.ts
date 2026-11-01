import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import * as zod from "zod";
import { findVideoToCopy, markPlayableCopy, type VideoToCopy } from "@/lib/media/rows";
import { derivedKey } from "@/lib/storage/keys";
import { headOriginal, putPublicObject } from "@/lib/storage/objects";
import type { JobReport, MediaJob, MediaJobHandler } from "../queues";
import { saveOriginal, withScratch } from "../scratch";
import { expectedLength, lengthProblem, type ExpectedLength } from "./convert";
import { contentHashOf, rewriteManifest, withdrawIfHidden, type JobQueue } from "./publishing";
import type { VideoFacts } from "./video-probe";
import {
  blameFileFromThirdAttempt,
  ffmpegGlobalArgs,
  probeVideo,
  runVideoTool,
  SCRATCH_FILE_READING,
  type VideoToolRun,
} from "./video-tools";

/*
 * media.playable (Task 14b): a clean copy of a video, playable as soon as its poster is, made for
 * every video whose streams an MP4 carries as they are (H.264 or HEVC, with AAC or no sound). It is
 * the original's own video and sound, stream-copied, nothing decoded: no metadata but the capture
 * time, so no location; `moov` first, so a phone plays it as it downloads; its display matrix kept,
 * so players turn it. An H.264 video every phone plays (the Android case) plays from this copy, and
 * its original is never used for playback; an HEVC or HDR one plays from it where the phone can
 * (canPlayType), and from its H.264 conversion (media.convert) once that is done.
 *
 * Its own job, not a step of the poster's: a 2 GB original's download, copy and upload take a
 * minute or two, which would hold up every other video's poster behind it (media.poster runs one
 * at a time), and a copy that fails gets its own retries. The poster job sends it once the video is
 * ready (never before, so it never delays the poster's ready mark), and an unhide's poster job sends
 * it again for the new generation. A job (the command follows the ffmpeg notes, §2.0, §2.3, §4.1,
 * §4.12, §4.13):
 * 1. finds a ready, visible album video with no copy yet (Ruling AG): anything else, a second
 *    delivery included, does nothing;
 * 2. streams the original into its scratch folder (twice its size must be free: the original, the
 *    copy, and `moov` moved to the front in place, §4.13) and probes it there;
 * 3. copies its video and sound into an MP4 (HEVC tagged hvc1), nice'd, under the probe's memory
 *    cap (a copy decodes nothing) and five minutes of CPU time, from the scratch file only;
 * 4. checks what ffmpeg made, since exiting 0 isn't success (§4.17): one video stream of the
 *    original's codec, tagged avc1 or hvc1, turned as the original was, its AAC if it had sound, nothing else, as long
 *    as the original, `moov` before `mdat`, and no location in its index in any form a phone writes;
 * 5. puts it in the public bucket under a content hash, cached for good, names it `derived.playable`
 *    while the video is still ready, visible and in the same generation, and writes its manifest.
 * A video hidden (or unhidden into a new generation) while it worked publishes nothing: its file
 * comes down, recorded for media.visibility (withdrawIfHidden). A copy that fails is never the
 * video's failure: it stays ready with its poster, its conversion goes on where it has one, and
 * media.dead only logs it, with ids only (Rulings AL, AT).
 */

/**
 * Part of every playable copy's key. Raise it whenever what this job makes changes, so the files
 * made again get new keys, which no cache has seen.
 */
const PLAYABLE_SETTINGS_VERSION = 1;
/** The video codecs a copy carries as they are: what phones record, which an MP4 holds. */
const COPYABLE_VIDEO_CODECS = new Set(["h264", "hevc"]);
/** ffprobe reads only a file's index and a few MB, from the scratch disk. */
const PROBE_MILLISECONDS = 60_000;
/**
 * The copy's time: it decodes nothing, reading and writing the file twice (the second time to move
 * `moov` to the front, ffmpeg notes §4.13). A 2 GB original on the scratch disk's NVMe takes well
 * under a minute; fifteen leave room for a busy disk, inside the job's hour (media.playable's
 * expireInSeconds) with the download and the upload.
 */
const COPY_MILLISECONDS = 15 * 60_000;
/**
 * The copy's CPU time (prlimit --cpu, Ruling AR): a 2 GB original copied in 7 CPU-seconds
 * (measured, Task 14b), so five minutes is forty times that. A file that makes the copy spin is
 * blamed from its third attempt, rather than hold the queue's one slot for 15 minutes an attempt.
 */
const COPY_CPU_SECONDS = 300;
/** Scratch beyond twice the original: `moov` moved to the front, and a small original's headers. */
const SCRATCH_MARGIN_BYTES = 64 * 1024 * 1024;
/**
 * The most of the copy's non-media boxes (its index, `moov`) read for the check: a 2 GB, 30-minute
 * phone video's index is a few MB, its sample tables most of it.
 */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

/**
 * A media.playable job's data: its video, and the generation of the files it is sent for, which
 * the sweeper's step 5 tells one generation's job from another's by. The job itself reads only the
 * id: what it copies is whatever generation the row is in when it runs.
 */
export type PlayableJobData = { mediaId: string; generation: number };

/** What the job takes from the worker's settings. */
export type PlayableOptions = {
  /** The memory (address space) ffprobe and the copy's ffmpeg may take: WORKER_FFMPEG_MEMORY_BYTES. */
  ffmpegMemoryBytes: number;
  /** The job queue a withdrawal is sent to, for a video hidden while its copy was made. */
  jobQueue: JobQueue;
};

/** What the scratch folder's work made, or that it made nothing for streams an MP4 doesn't carry. */
type Copy =
  | { made: true; facts: VideoFacts; outputBytes: number; downloadMilliseconds: number; copyMilliseconds: number; uploadMilliseconds: number }
  | { made: false; facts: VideoFacts };

/**
 * Whether an MP4 carries the video's streams as they are, for a phone to play: H.264 or HEVC
 * video, with AAC or no sound. A browser's VP8, VP9 or AV1, Opus and other sound, are its
 * conversion's to make playable.
 */
export function streamsCopyable(facts: Pick<VideoFacts, "codec" | "audioCodec">): boolean {
  return COPYABLE_VIDEO_CODECS.has(facts.codec) && (facts.audioCodec === null || facts.audioCodec === "aac");
}

/**
 * ffmpeg's arguments for the copy (ffmpeg notes §2.0, §2.3), in the job's scratch folder:
 * - the original opened as a file only, by one of the two video demuxers, -xerror (§2.0);
 * - -map by the probe's indexes: the video and the one sound stream it picked, never an iPhone's
 *   `mebx` metadata tracks, a subtitle or a second video (§2.3);
 * - -c copy: nothing decoded, so nothing turned either (autorotate acts only on decoded frames,
 *   §4.1): the display matrix is the stream's side data, not metadata, which the copy keeps and
 *   players obey (§4.1, "Rotation survives -map_metadata -1 on stream copy");
 * - -map_metadata -1 and -map_chapters -1 drop every tag, location included (`©xyz`, `loci`,
 *   Apple's location key), and only the capture time is written back (§4.12);
 * - HEVC is tagged hvc1 (-tag, ffmpeg §5.4), whatever the original's: -c copy would keep an hev1
 *   tag, or a Matroska original's none, which Apple's players refuse; an iPhone's hvc1 stays so.
 *   H.264 only, never: the MP4 muxer refuses hvc1 for it;
 * - +faststart writes the `moov` before the `mdat`, by a second pass over a regular file (§4.13).
 */
export function remuxArgs(
  facts: Pick<VideoFacts, "streamIndex" | "audioStreamIndex" | "codec">,
  paths: { original: string; output: string },
  capturedAt: Date | null,
): string[] {
  const audio = facts.audioStreamIndex;
  return [
    // No filters run in a copy: one filter thread is never started.
    ...ffmpegGlobalArgs(1),
    ...SCRATCH_FILE_READING,
    ...["-i", paths.original],
    ...["-map", `0:${facts.streamIndex}`, ...(audio === null ? [] : ["-map", `0:${audio}`])],
    ...["-c", "copy"],
    ...(facts.codec === "hevc" ? ["-tag:v", "hvc1"] : []),
    ...["-map_metadata", "-1", "-map_chapters", "-1"],
    // ISO 8601, which ffmpeg stores in mvhd, tkhd and mdhd to the second (§2.3).
    ...(capturedAt === null ? [] : ["-metadata", `creation_time=${capturedAt.toISOString()}`]),
    ...["-movflags", "+faststart", "-f", "mp4", paths.output],
  ];
}

/** What ffprobe is asked of the copy: its streams, their tags, lengths and display matrices, and the file's length. */
const COPY_ENTRIES = "format=duration:stream=codec_type,codec_name,codec_tag_string,duration:stream_side_data_list";
/** The sample entry each copied codec must have in the MP4: what every phone's player looks for. */
const COPY_TAGS: Record<string, string> = { h264: "avc1", hevc: "hvc1" };

const text = zod.string().optional();
const copySchema = zod.object({
  format: zod.object({ duration: text }).optional(),
  streams: zod.array(
    zod.object({
      codec_type: text,
      codec_name: text,
      codec_tag_string: text,
      duration: text,
      side_data_list: zod.array(zod.object({ rotation: zod.number().optional() })).optional(),
    }),
  ),
});

/** A turn in whole degrees from 0 to 359: −90 and 270 are the same turn. */
function degrees(rotation: number): number {
  return ((Math.round(rotation) % 360) + 360) % 360;
}

/** What the copy must be, from the original's probe. */
export type ExpectedCopy = {
  /** The original's video codec. */
  codec: string;
  /** Whether the original had sound the copy keeps. */
  audio: boolean;
  /** The original's display matrix's turn, counter-clockwise (0 for none). */
  rotation: number;
  length: ExpectedLength;
};

/**
 * What is wrong with the copy, from ffprobe's JSON (COPY_ENTRIES), or null when it is what the
 * album serves (ffmpeg notes §4.17): one video stream, the original's codec tagged as phones expect
 * (avc1, hvc1), turned as the original
 * (its display matrix kept, §4.1), its AAC when it had sound and no sound otherwise, nothing else
 * (no subtitle or data track), and as long as the original, within half a second. Exported for its test.
 */
export function copyProblem(probeJson: unknown, expected: ExpectedCopy): string | null {
  const parsed = copySchema.safeParse(probeJson);
  if (!parsed.success) return "ffprobe couldn't describe the copy";
  const { streams, format } = parsed.data;
  const videos = streams.filter((stream) => stream.codec_type === "video");
  if (videos.length !== 1) return `the copy has ${videos.length} video streams, not one`;
  const other = streams.find((stream) => stream.codec_type !== "video" && stream.codec_type !== "audio");
  if (other) return `the copy carries a ${other.codec_type ?? "nameless"} stream`;
  const [video] = videos;
  if (video.codec_name !== expected.codec) return `the copy's video is ${video.codec_name ?? "of no codec"}, not the original's ${expected.codec}`;
  const tag = COPY_TAGS[expected.codec];
  if (tag && video.codec_tag_string !== tag) return `the copy's ${expected.codec} is tagged ${video.codec_tag_string ?? "nothing"}, not ${tag}`;
  const turn = video.side_data_list?.find((sideData) => typeof sideData.rotation === "number")?.rotation ?? 0;
  if (degrees(turn) !== degrees(expected.rotation)) {
    return `the copy's display matrix turns it ${degrees(turn)}°, the original ${degrees(expected.rotation)}°`;
  }
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (expected.audio && (audios.length !== 1 || audios[0].codec_name !== "aac")) {
    return "the copy has no AAC audio, though the original had";
  }
  if (!expected.audio && audios.length > 0) return `the copy has ${audios.length} audio stream(s), the original none`;
  return lengthProblem("the copy's", expected.length, { video: video.duration, file: format?.duration });
}

/** Boxes that hold other boxes, where metadata may be. `stbl`, the sample tables, holds only numbers and is passed over. */
const CONTAINER_BOXES = new Set(["moov", "trak", "mdia", "minf", "dinf", "edts", "udta", "meta", "ilst", "tref", "mvex"]);
/** The boxes a location is written in: QuickTime's `©xyz` (in udta, or ilst) and 3GPP's `loci` (ffmpeg notes §4.12). */
const LOCATION_BOXES = new Set(["©xyz", "loci"]);
/** The words of a location kept as text: Apple's `com.apple.quicktime.location.ISO6709` key, or a tag named so. */
const LOCATION_WORDS = ["location", "ISO6709"];

type Box = { type: string; contentStart: number; end: number };

/** The boxes from `start` to `end`, or null when the bytes there aren't boxes. A tail under a box header (QuickTime's 0 terminator) is left. */
function boxesIn(bytes: Buffer, start: number, end: number): Box[] | null {
  const boxes: Box[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = bytes.readUInt32BE(position);
    let headerSize = 8;
    if (size === 1) {
      if (position + 16 > end) return null;
      size = Number(bytes.readBigUInt64BE(position + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = end - position;
    }
    if (size < headerSize || position + size > end) return null;
    boxes.push({ type: bytes.toString("latin1", position + 4, position + 8), contentStart: position + headerSize, end: position + size });
    position += size;
  }
  return boxes;
}

/** A location word in these bytes, or null. */
function locationWordIn(bytes: Buffer, start: number, end: number): string | null {
  const content = bytes.subarray(start, end);
  return LOCATION_WORDS.find((word) => content.includes(word, 0, "latin1")) ?? null;
}

/**
 * A location in the boxes from `start` to `end`: a location box anywhere in the tree, or a location
 * word in any box that isn't a container (a `keys` box's names), the sample tables passed over (their
 * numbers could spell anything). Bytes that aren't boxes are read as text.
 */
function locationIn(bytes: Buffer, start: number, end: number): string | null {
  const boxes = boxesIn(bytes, start, end);
  if (boxes === null) return locationWordIn(bytes, start, end);
  for (const box of boxes) {
    if (LOCATION_BOXES.has(box.type)) return box.type;
    if (box.type === "stbl") continue;
    if (!CONTAINER_BOXES.has(box.type)) {
      const word = locationWordIn(bytes, box.contentStart, box.end);
      if (word) return word;
      continue;
    }
    // ISO's `meta` is a full box (4 bytes of version and flags before its children); QuickTime's
    // starts with its `hdlr` at once.
    const quickTimeMeta = box.type === "meta" && bytes.toString("latin1", box.contentStart + 4, box.contentStart + 8) === "hdlr";
    const childrenStart = box.type === "meta" && !quickTimeMeta ? box.contentStart + 4 : box.contentStart;
    const found = locationIn(bytes, childrenStart, box.end);
    if (found) return found;
  }
  return null;
}

/** Top-level boxes that hold the media itself, or nothing: never read. */
const DATA_BOXES = new Set(["mdat", "free", "skip", "wide"]);

/**
 * What is wrong with the copy's container, or null: it must have its index (`moov`) before its
 * media (`mdat`), so a phone plays it while it downloads (ffmpeg notes §4.13), and no location in
 * any form a phone writes, anywhere but in the media itself (§4.12). Reads only the box headers and
 * the boxes that aren't media, never the whole file. Exported for its test.
 */
export async function containerProblem(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const order: string[] = [];
    let readBytes = 0;
    let position = 0;
    while (position + 8 <= size) {
      const header = Buffer.alloc(16);
      await file.read(header, 0, 16, position);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString("latin1", 4, 8);
      const headerSize = boxSize === 1 ? 16 : 8;
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      if (boxSize === 0) boxSize = size - position;
      if (boxSize < headerSize || position + boxSize > size) return `the copy's box ${JSON.stringify(type)} runs past its end`;
      order.push(type);
      if (!DATA_BOXES.has(type)) {
        readBytes += boxSize;
        if (readBytes > MAX_INDEX_BYTES) return `the copy's index is past the ${MAX_INDEX_BYTES} bytes the worker reads`;
        const box = Buffer.alloc(boxSize);
        await file.read(box, 0, boxSize, position);
        const location = locationIn(box, 0, boxSize);
        if (location) return `the copy still holds a location (${location})`;
      }
      position += boxSize;
    }
    const index = order.indexOf("moov");
    if (index === -1) return "the copy has no index (moov)";
    const media = order.indexOf("mdat");
    if (media !== -1 && media < index) return "the copy's index (moov) comes after its data (mdat): no faststart";
    return null;
  } finally {
    await file.close();
  }
}

/**
 * Checks ffmpeg's copy: there, not empty, what copyProblem and containerProblem want. A problem is
 * the file's from the third attempt (an original cut short that still passes ffprobe copies short
 * every time), the worker's before it.
 */
async function checkCopy(output: string, facts: VideoFacts, run: VideoToolRun): Promise<number> {
  const bytes = await stat(output).then(
    (file) => file.size,
    () => 0,
  );
  if (bytes === 0) throw blameFileFromThirdAttempt("ffmpeg exited 0 but wrote nothing", run.retryCount, run.source);
  const { stdout } = await runVideoTool(
    "ffprobe",
    ["-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov"]
      .concat(["-print_format", "json", "-show_error", "-show_entries", COPY_ENTRIES, output]),
    run,
    PROBE_MILLISECONDS,
  );
  let description: unknown = null;
  try {
    description = JSON.parse(stdout);
  } catch {
    // copyProblem says so.
  }
  const problem =
    copyProblem(description, {
      codec: facts.codec,
      audio: facts.audioStreamIndex !== null,
      rotation: facts.rotation,
      length: expectedLength(facts),
    }) ?? (await containerProblem(output));
  if (problem) throw blameFileFromThirdAttempt(`ffmpeg exited 0, but ${problem}`, run.retryCount, run.source);
  return bytes;
}

/** Downloads, probes, copies, checks and uploads, in the job's scratch folder. */
async function copyIn(folder: string, job: MediaJob, video: VideoToCopy, key: string, options: PlayableOptions): Promise<Copy> {
  const run: VideoToolRun = {
    memoryBytes: options.ffmpegMemoryBytes,
    signal: job.signal,
    folder,
    retryCount: job.retryCount,
    // The brief's background priority: a photo or a poster a guest waits for goes first.
    priority: "background",
    source: "scratch",
  };
  const paths = { original: join(folder, "original"), output: join(folder, "playable.mp4") };

  const downloadStartedAt = performance.now();
  await saveOriginal(video.originalKey, paths.original, job.signal);
  const copyStartedAt = performance.now();
  const facts = await probeVideo(SCRATCH_FILE_READING, paths.original, run, PROBE_MILLISECONDS);
  if (!streamsCopyable(facts)) return { made: false, facts };
  await runVideoTool("ffmpeg", remuxArgs(facts, paths, video.capturedAt), { ...run, cpuSeconds: COPY_CPU_SECONDS }, COPY_MILLISECONDS);
  const outputBytes = await checkCopy(paths.output, facts, run);
  const uploadStartedAt = performance.now();
  const copied = createReadStream(paths.output);
  try {
    await putPublicObject(key, copied, "video/mp4", { signal: job.signal });
  } finally {
    copied.destroy();
  }
  return {
    made: true,
    facts,
    outputBytes,
    downloadMilliseconds: Math.round(copyStartedAt - downloadStartedAt),
    copyMilliseconds: Math.round(uploadStartedAt - copyStartedAt),
    uploadMilliseconds: Math.round(performance.now() - uploadStartedAt),
  };
}

/** media.playable's work for one job, whose data is `{ mediaId }`. */
export async function makePlayableCopy(job: MediaJob, options: PlayableOptions): Promise<JobReport | void> {
  const mediaId = typeof job.data.mediaId === "string" ? job.data.mediaId : "";
  const video = await findVideoToCopy(mediaId);
  if (!video) {
    console.log(
      `[worker] media.playable job=${job.id}: nothing to do, the video has its copy, or isn't a ready, visible album video`,
    );
    return;
  }
  const original = await headOriginal(video.originalKey, { signal: job.signal });
  if (!original) throw new Error(`The original ${video.originalKey} isn't in the private bucket`);
  const contentHash = contentHashOf(original.etag, `playable-settings-${PLAYABLE_SETTINGS_VERSION}`, video.derivedGeneration);
  const key = derivedKey(mediaId, contentHash, "playable", "mp4");

  const copy = await withScratch(2 * original.size + SCRATCH_MARGIN_BYTES, (folder) => copyIn(folder, job, video, key, options));
  if (!copy.made) {
    const streams = [copy.facts.codec, copy.facts.audioCodec].filter((codec) => codec !== null);
    console.log(
      `[worker] media.playable job=${job.id} media=${mediaId}: no playable copy, as an MP4 doesn't carry ${streams.join(" and ")} ` +
        `as ${streams.length > 1 ? "they are" : "it is"}; it plays from its conversion`,
    );
    return;
  }
  console.log(
    `[worker] media.playable job=${job.id} media=${mediaId}: downloaded in ${copy.downloadMilliseconds} ms, ` +
      `copied in ${copy.copyMilliseconds} ms to ${copy.outputBytes} bytes, uploaded in ${copy.uploadMilliseconds} ms`,
  );

  const manifest = await markPlayableCopy(mediaId, { key, derivedGeneration: video.derivedGeneration });
  if (!manifest) {
    // Hidden, deleted, or unhidden into a new generation while it was made: the copy comes down.
    await withdrawIfHidden(job.queue, mediaId, [key], {
      signal: job.signal,
      jobQueue: options.jobQueue,
      derivedGeneration: video.derivedGeneration,
    });
    return;
  }
  await rewriteManifest(job.queue, mediaId, manifest, job.signal);
  return { sizeBytes: original.size, kind: `video/${copy.facts.codec}` };
}

/** media.playable's handler, with the worker's settings. */
export function playableHandler(options: PlayableOptions): MediaJobHandler {
  return (job) => makePlayableCopy(job, options);
}
