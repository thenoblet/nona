import { describe, expect, it } from "vitest";
import { albumSummaryWords, parseFilter } from "./album-item";

describe("albumSummaryWords", () => {
  it("counts the photos, the videos and the guests who shared them", () => {
    expect(albumSummaryWords({ photos: 1240, videos: 86, sharers: 180 })).toBe("1,240 photos and 86 videos from 180 of you, all in one place.");
  });

  it("says one photo, one video, and leaves out a kind there is none of", () => {
    expect(albumSummaryWords({ photos: 1, videos: 1, sharers: 1 })).toBe("1 photo and 1 video from 1 of you, all in one place.");
    expect(albumSummaryWords({ photos: 12, videos: 0, sharers: 3 })).toBe("12 photos from 3 of you, all in one place.");
    expect(albumSummaryWords({ photos: 0, videos: 2, sharers: 2 })).toBe("2 videos from 2 of you, all in one place.");
  });

  it("names no one when no guest is behind the moments, and counts nothing in an empty album or one it can't read", () => {
    expect(albumSummaryWords({ photos: 3, videos: 0, sharers: 0 })).toBe("3 photos, all in one place.");
    expect(albumSummaryWords({ photos: 0, videos: 0, sharers: 0 })).toBe("Every photo and video you share, all in one place.");
    expect(albumSummaryWords(null)).toBe("Every photo and video you share, all in one place.");
  });

  it("never shows a placeholder in brackets", () => {
    for (const counts of [null, { photos: 0, videos: 0, sharers: 0 }, { photos: 5, videos: 5, sharers: 5 }]) {
      expect(albumSummaryWords(counts)).not.toMatch(/[[\]]/);
    }
  });
});

describe("parseFilter", () => {
  it("reads an old Thanksgiving chip as the whole album", () => {
    const filter = parseFilter(new URLSearchParams("celebration=thanks"));
    expect(filter).not.toBeNull();
    expect(filter?.celebration).toBeUndefined();
  });
});
