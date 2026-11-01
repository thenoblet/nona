import { describe, expect, it } from "vitest";
import type { AlbumItem } from "@/lib/media/album-item";
import { downloadChoices, savable } from "./downloads";

function item(overrides: Partial<AlbumItem>): AlbumItem {
  return {
    id: "7f3k2a9c-0000-4000-8000-000000000001",
    kind: "photo",
    status: "ready",
    mine: false,
    by: "Efua",
    celebration: "reception",
    takenAt: "2026-12-05T19:42:00.000Z",
    listedAt: "2026-12-05T19:43:00.000Z",
    width: 1200,
    height: 1600,
    thumbhash: null,
    color: null,
    thumb: "https://media.example/thumb.webp",
    view: "https://media.example/view.webp",
    seconds: null,
    video: null,
    heic: false,
    original: { type: "JPEG", bytes: 4_200_000 },
    failure: null,
    ...overrides,
  };
}

const videoItem = (overrides: Partial<NonNullable<AlbumItem["video"]>>, itemOverrides: Partial<AlbumItem> = {}) =>
  item({
    kind: "video",
    seconds: 27,
    original: { type: "MOV", bytes: 84_000_000 },
    video: { converted: null, copy: null, codec: "hevc", conversion: "queued", conversionFailure: null, ...overrides },
    ...itemOverrides,
  });

// Gate B's menu (1b): a photo, its original; a video, For your phone (the default) and its
// original; an iPhone photo, As JPEG and its original.
describe("downloadChoices", () => {
  it("offers a photo's original, with its type and size", () => {
    expect(downloadChoices(item({}))).toEqual([
      { variant: "original", label: "Original photo", sub: "JPEG · 4.0 MB · full size", disabled: false, prepare: false },
    ]);
  });

  it("offers an iPhone photo as a JPEG first, which the first request makes, and its original", () => {
    expect(downloadChoices(item({ heic: true, original: { type: "HEIC", bytes: 2_100_000 } }))).toEqual([
      { variant: "jpeg", label: "As JPEG", sub: "Opens on any phone", disabled: false, prepare: true },
      { variant: "original", label: "Original file", sub: "HEIC · 2.0 MB · iPhone format", disabled: false, prepare: false },
    ]);
  });

  it("offers a video for the phone (the conversion, else the clean copy) first, and its original as shared", () => {
    expect(downloadChoices(videoItem({ converted: "https://media.example/video.mp4", conversion: "done" }))).toEqual([
      { variant: "converted", label: "For your phone", sub: "MP4 · plays on any phone", disabled: false, prepare: false },
      { variant: "original", label: "Original file", sub: "MOV · 80.1 MB · as Efua shared it", disabled: false, prepare: false },
    ]);
    expect(downloadChoices(videoItem({ codec: "h264", copy: "https://media.example/playable.mp4" }))[0]).toMatchObject({
      variant: "converted",
      disabled: false,
    });
    expect(downloadChoices(videoItem({}, { mine: true }))).toEqual([
      { variant: "converted", label: "For your phone", sub: "Getting it ready…", disabled: true, prepare: false },
      { variant: "original", label: "Original file", sub: "MOV · 80.1 MB · as you shared it", disabled: false, prepare: false },
    ]);
  });
});

// Save to Photos saves what the menu leads with, and for a video only a version this phone plays:
// while that is being made, it waits (Noblet's pick: never the original).
describe("savable", () => {
  it("saves a photo's original, an iPhone photo's JPEG, and a video's version this phone plays", () => {
    expect(savable(item({}), null)).toEqual({ variant: "original", extension: "jpg", type: "image/jpeg" });
    expect(savable(item({ heic: true, original: { type: "HEIC", bytes: 1 } }), null)).toEqual({ variant: "jpeg", extension: "jpg", type: "image/jpeg" });
    expect(savable(item({ original: { type: "PNG", bytes: 1 } }), null)).toEqual({ variant: "original", extension: "png", type: "image/png" });
    // A video's version carries its download too, for when its file won't fetch (Ruling BO).
    expect(savable(videoItem({}), { kind: "copy", url: "https://media.example/playable.mp4" })).toEqual({
      variant: "converted",
      url: "https://media.example/playable.mp4",
      extension: "mp4",
      type: "video/mp4",
    });
    expect(savable(videoItem({}), { kind: "preparing", ask: true })).toBeNull();
    expect(savable(videoItem({}), { kind: "failed", words: "…" })).toBeNull();
  });
});
