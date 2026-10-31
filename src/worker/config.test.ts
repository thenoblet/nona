import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conversionPeakBytes, workerConfig } from "./config";

describe("workerConfig", () => {
  it("defaults to what a 3 CPU / 12 GB box runs at once (Ruling Q)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).concurrency).toEqual({
      photo: 2,
      jpeg: 1,
      poster: 1,
      wish: 1,
      visibility: 2,
      card: 1,
      convertOnDemand: 1,
      convertBacklog: 1,
      playable: 1,
    });
  });

  it("gives each tool one thread per job, x264 two, and never counts the machine's cores (Ruling R)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).threads).toEqual({
      x264: 2,
      sharp: 1,
      ffmpegFilters: 1,
      heif: 1,
      poster: 1,
      decoder: 2,
    });
  });

  it("gives a conversion that runs alone every CPU the container has: 3 unless WORKER_CPUS says otherwise (Ruling R)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).cpus).toBe(3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "" }).cpus).toBe(3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "16" }).cpus).toBe(16);
    for (const value of ["0", "1.5", "all", "65"]) {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_CPUS: value }), value).toThrow(/WORKER_CPUS/);
    }
  });

  it("caps no conversion's bitrate unless both WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE are set: pure CRF 23 (Noblet)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).x264Cap).toBeNull();
    expect(workerConfig({ NODE_ENV: "development", WORKER_X264_MAXRATE: "", WORKER_X264_BUFSIZE: "" }).x264Cap).toBeNull();
    expect(workerConfig({ NODE_ENV: "development", WORKER_X264_MAXRATE: "5M", WORKER_X264_BUFSIZE: "10M" }).x264Cap).toEqual({
      maxRate: "5M",
      bufferSize: "10M",
    });
    expect(
      workerConfig({ NODE_ENV: "development", WORKER_X264_MAXRATE: "4500k", WORKER_X264_BUFSIZE: "9000000" }).x264Cap,
    ).toEqual({ maxRate: "4500k", bufferSize: "9000000" });
  });

  it("refuses one of the two without the other, and anything but a bitrate", () => {
    for (const half of [{ WORKER_X264_MAXRATE: "5M" }, { WORKER_X264_BUFSIZE: "10M" }, { WORKER_X264_MAXRATE: "5M", WORKER_X264_BUFSIZE: "" }]) {
      expect(() => workerConfig({ NODE_ENV: "development", ...half }), JSON.stringify(half)).toThrow(
        /WORKER_X264_MAXRATE and WORKER_X264_BUFSIZE: set both/,
      );
    }
    for (const value of ["0", "5 M", "5Mi", "-5M", "5M -crf 0", "fast"]) {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_X264_MAXRATE: value, WORKER_X264_BUFSIZE: "10M" }), value).toThrow(
        /WORKER_X264_MAXRATE/,
      );
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_X264_MAXRATE: "5M", WORKER_X264_BUFSIZE: value }), value).toThrow(
        /WORKER_X264_BUFSIZE/,
      );
    }
  });

  it("opens a job-queue pool big enough for every handler at once", () => {
    expect(workerConfig({ NODE_ENV: "development" }).queuePoolSize).toBe(10);
  });

  it("takes every concurrency, thread count and the pool size from the environment", () => {
    const config = workerConfig({
      NODE_ENV: "development",
      WORKER_PHOTO_CONCURRENCY: "6",
      WORKER_JPEG_CONCURRENCY: "2",
      WORKER_POSTER_CONCURRENCY: "3",
      WORKER_WISH_CONCURRENCY: "2",
      WORKER_VISIBILITY_CONCURRENCY: "4",
      WORKER_CARD_CONCURRENCY: "2",
      WORKER_CONVERT_ON_DEMAND_CONCURRENCY: "2",
      WORKER_CONVERT_BACKLOG_CONCURRENCY: "5",
      WORKER_PLAYABLE_CONCURRENCY: "3",
      WORKER_X264_THREADS: "4",
      WORKER_SHARP_THREADS: "3",
      WORKER_FFMPEG_FILTER_THREADS: "2",
      WORKER_HEIF_THREADS: "4",
      WORKER_POSTER_THREADS: "2",
      WORKER_FFMPEG_DECODER_THREADS: "3",
      WORKER_QUEUE_POOL_SIZE: "20",
    });
    expect(config.concurrency).toEqual({
      photo: 6,
      jpeg: 2,
      poster: 3,
      wish: 2,
      visibility: 4,
      card: 2,
      convertOnDemand: 2,
      convertBacklog: 5,
      playable: 3,
    });
    expect(config.threads).toEqual({ x264: 4, sharp: 3, ffmpegFilters: 2, heif: 4, poster: 2, decoder: 3 });
    expect(config.queuePoolSize).toBe(20);
  });

  it("caps heif-dec's memory at 2 GiB unless WORKER_HEIF_MEMORY_BYTES says otherwise", () => {
    expect(workerConfig({ NODE_ENV: "development" }).heifMemoryBytes).toBe(2 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_HEIF_MEMORY_BYTES: "" }).heifMemoryBytes).toBe(2 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_HEIF_MEMORY_BYTES: "3221225472" }).heifMemoryBytes).toBe(3 * 1024 ** 3);
  });

  it.each(["1048576", "2GB", "-1", "1.5", String(128 * 1024 ** 3)])(
    "refuses %j as heif-dec's memory cap: bytes, from 256 MiB (below that no photo decodes) to 64 GiB",
    (value) => {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_HEIF_MEMORY_BYTES: value })).toThrow(
        /WORKER_HEIF_MEMORY_BYTES/,
      );
    },
  );

  it("caps ffprobe's and ffmpeg's memory at 2 GiB unless WORKER_FFMPEG_MEMORY_BYTES says otherwise", () => {
    expect(workerConfig({ NODE_ENV: "development" }).ffmpegMemoryBytes).toBe(2 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_FFMPEG_MEMORY_BYTES: "" }).ffmpegMemoryBytes).toBe(2 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_FFMPEG_MEMORY_BYTES: "4294967296" }).ffmpegMemoryBytes).toBe(
      4 * 1024 ** 3,
    );
  });

  it.each(["536870912", "2GB", "-1", "1.5", String(128 * 1024 ** 3)])(
    "refuses %j as ffmpeg's memory cap: bytes, from 1 GiB (below that a 4K HDR poster can't be made) to 64 GiB",
    (value) => {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_FFMPEG_MEMORY_BYTES: value })).toThrow(
        /WORKER_FFMPEG_MEMORY_BYTES/,
      );
    },
  );

  it("caps a conversion's ffmpeg at 3 GiB unless WORKER_CONVERT_MEMORY_BYTES says otherwise", () => {
    expect(workerConfig({ NODE_ENV: "development" }).convertMemoryBytes).toBe(3 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MEMORY_BYTES: "" }).convertMemoryBytes).toBe(3 * 1024 ** 3);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MEMORY_BYTES: "4294967296" }).convertMemoryBytes).toBe(
      4 * 1024 ** 3,
    );
  });

  it("raises a conversion's default cap with WORKER_CPUS, as its threads raise its need (Task 14b's measurements)", () => {
    // 3 threads: 1,900 MiB measured need, under the 3 GiB floor. 8: 2,650 × 1.6. 16: 3,850 × 1.6, in whole 256 MiB.
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "3" }).convertMemoryBytes).toBe(3072 * 1024 ** 2);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "8" }).convertMemoryBytes).toBe(4352 * 1024 ** 2);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "16" }).convertMemoryBytes).toBe(6400 * 1024 ** 2);
    expect(conversionPeakBytes(16)).toBe(3850 * 1024 ** 2);
  });

  it("refuses to start with a conversion cap under what a lone conversion on WORKER_CPUS threads needs, rather than fail every video as corrupt", () => {
    expect(() => workerConfig({ NODE_ENV: "development", WORKER_CPUS: "16", WORKER_CONVERT_MEMORY_BYTES: String(3 * 1024 ** 3) })).toThrow(
      /WORKER_CONVERT_MEMORY_BYTES: 3221225472 bytes is under the 4037017600 a 4K HDR conversion needs on 16 threads \(WORKER_CPUS\)/,
    );
    expect(workerConfig({ NODE_ENV: "development", WORKER_CPUS: "16", WORKER_CONVERT_MEMORY_BYTES: String(6 * 1024 ** 3) }).convertMemoryBytes).toBe(
      6 * 1024 ** 3,
    );
    // The shared counts too, if someone sets them above WORKER_CPUS.
    expect(() =>
      workerConfig({ NODE_ENV: "development", WORKER_X264_THREADS: "16", WORKER_CONVERT_MEMORY_BYTES: String(3 * 1024 ** 3) }),
    ).toThrow(/on 16 threads/);
  });

  it.each(["1073741824", "3GB", "-1", "1.5", String(128 * 1024 ** 3)])(
    "refuses %j as a conversion's memory cap: bytes, from 2 GiB (below that a 4K HDR conversion can't run) to 64 GiB",
    (value) => {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MEMORY_BYTES: value })).toThrow(
        /WORKER_CONVERT_MEMORY_BYTES/,
      );
    },
  );

  it("converts videos up to 30 minutes long unless WORKER_CONVERT_MAX_SECONDS says otherwise (Ruling AR)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).convertMaxSeconds).toBe(1800);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MAX_SECONDS: "" }).convertMaxSeconds).toBe(1800);
    expect(workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MAX_SECONDS: "3600" }).convertMaxSeconds).toBe(3600);
    for (const value of ["0", "59", "1.5", "half an hour", String(24 * 3600 + 1)]) {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_CONVERT_MAX_SECONDS: value }), value).toThrow(
        /WORKER_CONVERT_MAX_SECONDS/,
      );
    }
  });

  it("converts at x264's veryfast preset unless WORKER_X264_PRESET names another of x264's presets", () => {
    expect(workerConfig({ NODE_ENV: "development" }).x264Preset).toBe("veryfast");
    expect(workerConfig({ NODE_ENV: "development", WORKER_X264_PRESET: "" }).x264Preset).toBe("veryfast");
    expect(workerConfig({ NODE_ENV: "development", WORKER_X264_PRESET: "faster" }).x264Preset).toBe("faster");
    for (const value of ["quick", "VERYFAST", "veryfast -crf 0", "placebo"]) {
      expect(() => workerConfig({ NODE_ENV: "development", WORKER_X264_PRESET: value }), value).toThrow(/WORKER_X264_PRESET/);
    }
  });

  it("treats a blank variable as unset, as Dokploy may leave one", () => {
    expect(workerConfig({ NODE_ENV: "development", WORKER_PHOTO_CONCURRENCY: "" }).concurrency.photo).toBe(2);
  });

  it.each(["0", "-1", "1.5", "two", "65"])("refuses %j as a count, naming the variable", (value) => {
    expect(() => workerConfig({ NODE_ENV: "development", WORKER_X264_THREADS: value })).toThrow(
      /WORKER_X264_THREADS/,
    );
  });

  it("requires WORKER_SCRATCH_DIR in production, so scratch never lands on the container's own disk", () => {
    expect(() => workerConfig({ NODE_ENV: "production" })).toThrow(/WORKER_SCRATCH_DIR/);
    expect(workerConfig({ NODE_ENV: "production", WORKER_SCRATCH_DIR: "/scratch" }).scratchRoot).toBe("/scratch");
  });

  it("uses a folder of its own under the system's temp folder outside production, never the temp folder itself", () => {
    expect(workerConfig({ NODE_ENV: "development" }).scratchRoot).toBe(join(tmpdir(), "nona-worker"));
    expect(workerConfig({}).scratchRoot).toBe(join(tmpdir(), "nona-worker"));
  });

  it("refuses a relative scratch folder", () => {
    expect(() => workerConfig({ NODE_ENV: "production", WORKER_SCRATCH_DIR: "scratch" })).toThrow(
      /WORKER_SCRATCH_DIR/,
    );
  });
});
