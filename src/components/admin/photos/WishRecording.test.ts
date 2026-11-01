import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AdminWish } from "@/lib/media/admin-item";
import { WishRecording } from "./WishRecording";

/*
 * The admin's Wishes tab plays a ready recording (Task 16): the file the wall plays, fetched only
 * once the couple press play, with its original a link away.
 */

function wish(kind: "voice" | "video", recording: Partial<NonNullable<AdminWish["recording"]>>): AdminWish {
  return {
    id: "c0ffee00-0000-4000-8000-000000000001",
    kind,
    message: null,
    signedAs: "Kwame",
    createdAt: "2026-12-05T20:48:00.000Z",
    hiddenAt: null,
    hiddenBy: null,
    recording: { mediaId: "c0ffee00-0000-4000-8000-0000000000aa", kind: kind === "voice" ? "audio" : "video", status: "ready", seconds: 42, url: null, poster: null, ...recording },
    deletableFrom: null,
    deletable: false,
  };
}

const markupOf = (shown: AdminWish) => renderToStaticMarkup(createElement(WishRecording, { wish: shown }));

describe("WishRecording", () => {
  it("plays a ready voice note from the file the wall plays, fetching nothing until play", () => {
    const markup = markupOf(wish("voice", { url: "https://media.example/derived/x/h/audio.m4a" }));
    expect(markup).toMatch(/<audio[^>]*src="https:\/\/media\.example\/derived\/x\/h\/audio\.m4a"[^>]*>/);
    expect(markup).toMatch(/<audio[^>]*preload="none"/);
    expect(markup).toMatch(/<audio[^>]*controls/);
    expect(markup).toContain('aria-label="Voice note from Kwame"');
    expect(markup).toContain("Voice note · 0:42");
    expect(markup).toContain('href="/admin/photos/original/c0ffee00-0000-4000-8000-0000000000aa"');
  });

  it("plays a ready video message with its poster, inline on a phone", () => {
    const markup = markupOf(wish("video", { url: "https://media.example/v.mp4", poster: "https://media.example/p.webp" }));
    expect(markup).toMatch(/<video[^>]*src="https:\/\/media\.example\/v\.mp4"/);
    expect(markup).toMatch(/<video[^>]*poster="https:\/\/media\.example\/p\.webp"/);
    expect(markup).toMatch(/<video[^>]*preload="none"/);
    expect(markup).toMatch(/<video[^>]*playsInline|<video[^>]*playsinline/i);
  });

  it("offers only the original while it is being made, after it failed, or once hidden (no played file)", () => {
    for (const status of ["uploaded", "failed", "ready"] as const) {
      const markup = markupOf(wish("voice", { status, url: null }));
      expect(markup, status).not.toMatch(/<audio|<video/);
      expect(markup).toContain("Open original");
    }
  });
});
