import { describe, expect, it } from "vitest";
import { contentDefaults } from "./defaults";
import { liveStreamState, visibleFaq } from "./live";
import type { SiteContent } from "./schema";

const streamUrl = "https://example.com/watch";

function contentWith(url: string | null, ceremony: { date: string; startTime: string | null }): SiteContent {
  return {
    ...contentDefaults,
    liveStream: { url },
    celebrations: contentDefaults.celebrations.map((celebration) =>
      celebration.id === "ceremony" ? { ...celebration, ...ceremony } : celebration,
    ),
  };
}

const ceremonyAtTen = { date: "2026-12-05", startTime: "10:00" };

describe("liveStreamState", () => {
  it("stays hidden without a link, even during the ceremony", () => {
    const state = liveStreamState(contentWith(null, ceremonyAtTen), new Date("2026-12-05T10:30:00Z"));
    expect(state).toEqual({ show: false, url: null });
  });

  it("stays hidden until an hour before the ceremony", () => {
    const state = liveStreamState(contentWith(streamUrl, ceremonyAtTen), new Date("2026-12-05T08:59:00Z"));
    expect(state.show).toBe(false);
  });

  it("shows from exactly an hour before the ceremony", () => {
    const state = liveStreamState(contentWith(streamUrl, ceremonyAtTen), new Date("2026-12-05T09:00:00Z"));
    expect(state).toEqual({ show: true, url: streamUrl });
  });

  it("counts a missing start time as the start of the day", () => {
    const content = contentWith(streamUrl, { date: "2026-12-05", startTime: null });
    expect(liveStreamState(content, new Date("2026-12-04T22:59:00Z")).show).toBe(false);
    expect(liveStreamState(content, new Date("2026-12-04T23:00:00Z")).show).toBe(true);
  });
});

describe("visibleFaq", () => {
  const liveStreamQuestions = (content: SiteContent) =>
    visibleFaq(content).filter((item) => item.topic === "live-stream");

  it("hides the live-stream answer without a link", () => {
    expect(liveStreamQuestions(contentWith(null, ceremonyAtTen))).toHaveLength(0);
    expect(visibleFaq(contentWith(null, ceremonyAtTen)).length).toBe(contentDefaults.faq.length - 1);
  });

  it("keeps the live-stream answer once there is a link", () => {
    expect(liveStreamQuestions(contentWith(streamUrl, ceremonyAtTen))).toHaveLength(1);
  });
});
