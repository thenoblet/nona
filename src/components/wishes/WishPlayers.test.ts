import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Wish } from "@/lib/data/types";
import { thumbSizeOf, VideoPlayer, VoicePlayer } from "./WishPlayers";

/*
 * What the wishes wall loads before a tap (Ruling BS, fix round 1): a video message is its 480 px
 * poster thumbnail, lazily, with its size given, and no video element at all; a voice note an audio
 * element that fetches nothing until play.
 */

const video: Wish = {
  id: "c0ffee00-0000-4000-8000-000000000001",
  kind: "video",
  signedAs: "Kofi",
  createdAt: "2026-12-05T20:48:00.000Z",
  duration: "0:24",
  recording: {
    url: "https://media.example/derived/v/0123456789abcdef/video.mp4",
    thumb: "https://media.example/derived/v/0123456789abcdef/poster-thumb.webp",
    color: "#a08070",
    width: 720,
    height: 1280,
  },
};

describe("the wall's video message, before a tap", () => {
  it("is its poster thumbnail, lazy, with its own size, on its average colour, and no video element", () => {
    const markup = renderToStaticMarkup(createElement(VideoPlayer, { wish: video, recording: video.recording!, index: 0 }));

    expect(markup).not.toMatch(/<video/);
    expect(markup).not.toContain("video.mp4");
    expect(markup).not.toContain("poster-view");
    const image = /<img[^>]*>/.exec(markup)?.[0] ?? "";
    expect(image).toContain('src="https://media.example/derived/v/0123456789abcdef/poster-thumb.webp"');
    expect(image).toContain('loading="lazy"');
    expect(image).toContain('decoding="async"');
    expect(image).toContain('width="270"');
    expect(image).toContain('height="480"');
    expect(markup).toContain("background-color:#a08070");
    expect(markup).toContain('aria-label="Play video message from Kofi"');
  });

  it("sizes the thumbnail as the worker made it: the picture within 480 px, never enlarged", () => {
    expect(thumbSizeOf({ width: 1280, height: 720 })).toEqual({ width: 480, height: 270 });
    expect(thumbSizeOf({ width: 320, height: 240 })).toEqual({ width: 320, height: 240 });
    expect(thumbSizeOf({ width: null, height: null })).toEqual({ width: 384, height: 480 });
  });
});

describe("the wall's voice note", () => {
  it("fetches nothing until play", () => {
    const voice: Wish = { ...video, kind: "voice", recording: { url: "https://media.example/a.m4a", thumb: null, color: null, width: null, height: null } };
    const markup = renderToStaticMarkup(createElement(VoicePlayer, { wish: voice, recording: voice.recording!, index: 0 }));
    expect(markup).toMatch(/<audio[^>]*preload="none"/);
    expect(markup).toContain('src="https://media.example/a.m4a"');
  });
});
