import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workerConfig } from "./config";

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
    });
  });

  it("gives each tool one thread per job, x264 two, and never counts the machine's cores (Ruling R)", () => {
    expect(workerConfig({ NODE_ENV: "development" }).threads).toEqual({
      x264: 2,
      sharp: 1,
      ffmpegFilters: 1,
      heif: 1,
      poster: 1,
    });
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
      WORKER_X264_THREADS: "4",
      WORKER_SHARP_THREADS: "3",
      WORKER_FFMPEG_FILTER_THREADS: "2",
      WORKER_HEIF_THREADS: "4",
      WORKER_POSTER_THREADS: "2",
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
    });
    expect(config.threads).toEqual({ x264: 4, sharp: 3, ffmpegFilters: 2, heif: 4, poster: 2 });
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
