import { describe, expect, it } from "vitest";
import type { AlbumVideo } from "@/lib/media/album-item";
import { choosePlayback, HEVC_MAIN10_TYPE, H264_TYPE } from "./playback";

const CONVERTED = "https://media.example/derived/v/1111/video.mp4";
const COPY = "https://media.example/derived/v/2222/playable.mp4";

/** A phone that answers canPlayType for HEVC (Main 10 included) as given, and plays H.264. */
function phone(hevc: "probably" | "maybe" | ""): (type: string) => string {
  return (type) => (type === HEVC_MAIN10_TYPE ? hevc : type === H264_TYPE ? "probably" : "");
}

function video(overrides: Partial<AlbumVideo>): AlbumVideo {
  return { converted: null, copy: null, codec: "hevc", conversion: "queued", conversionFailure: null, ...overrides };
}

// The controller's order (31 Oct), which replaces the brief's: the H.264 conversion; else the
// clean copy where this phone plays it (H.264 always; HEVC only on a "probably" for hvc1 Main 10);
// else the poster with "Preparing…", asking for a conversion (or waiting for a copy on its way that
// this phone will play). Never the original.
describe("choosePlayback", () => {
  it.each([
    ["converted, whatever else", video({ converted: CONVERTED, copy: COPY, conversion: "done" }), phone(""), { kind: "converted", url: CONVERTED }],
    ["converted, HEVC phone", video({ converted: CONVERTED, copy: COPY, conversion: "done" }), phone("probably"), { kind: "converted", url: CONVERTED }],
    ["H.264 copy, any phone", video({ codec: "h264", copy: COPY, conversion: "none" }), phone(""), { kind: "copy", url: COPY }],
    ["HEVC copy, phone says probably", video({ copy: COPY }), phone("probably"), { kind: "copy", url: COPY }],
    ["HEVC copy, phone only says maybe", video({ copy: COPY }), phone("maybe"), { kind: "preparing", ask: true }],
    ["HEVC copy, phone can't", video({ copy: COPY }), phone(""), { kind: "preparing", ask: true }],
    ["HEVC copy plays though its conversion failed", video({ copy: COPY, conversion: "failed", conversionFailure: "too-long" }), phone("probably"), { kind: "copy", url: COPY }],
    ["H.264 copy plays though its conversion failed", video({ codec: "h264", copy: COPY, conversion: "failed", conversionFailure: "too-slow" }), phone(""), { kind: "copy", url: COPY }],
    ["H.264, its copy on its way", video({ codec: "h264", conversion: "none" }), phone(""), { kind: "preparing", ask: false }],
    ["HEVC, copy on its way to a phone that plays it", video({}), phone("probably"), { kind: "preparing", ask: false }],
    ["HEVC, no copy, phone can't", video({}), phone(""), { kind: "preparing", ask: true }],
    ["VP9 (a browser's WebM), no copy ever", video({ codec: "vp9" }), phone("probably"), { kind: "preparing", ask: true }],
    ["not probed yet", video({ codec: null, conversion: "none" }), phone("probably"), { kind: "preparing", ask: true }],
    [
      "too long to convert, and no copy this phone plays",
      video({ copy: COPY, conversion: "failed", conversionFailure: "too-long" }),
      phone(""),
      { kind: "failed", words: "Too long to prepare for your phone. Download the original." },
    ],
    [
      "too slow to convert, no copy",
      video({ conversion: "failed", conversionFailure: "too-slow" }),
      phone(""),
      { kind: "failed", words: "We couldn't prepare a version for your phone. Download the original." },
    ],
  ])("%s", (_case, input, canPlayType, expected) => {
    expect(choosePlayback(input, canPlayType)).toEqual(expected);
  });

  it("never plays an original: nothing it returns is a URL other than the conversion or the copy", () => {
    for (const hevc of ["probably", "maybe", ""] as const) {
      for (const codec of ["h264", "hevc", "vp9", null]) {
        for (const conversion of ["none", "queued", "converting", "done", "failed"] as const) {
          for (const copy of [COPY, null]) {
            const choice = choosePlayback(video({ codec, conversion, copy, converted: conversion === "done" ? CONVERTED : null }), phone(hevc));
            if ("url" in choice) expect([CONVERTED, COPY]).toContain(choice.url);
          }
        }
      }
    }
  });
});
