import { describe, expect, it } from "vitest";
import { TimeLeft, timeLeftWords } from "./time-left";

/*
 * The calm estimate of the time a big upload has left (Ruling BE): from the bytes measured going
 * out, smoothed, and in words that don't jump about.
 */

const MEGABYTE = 1_000_000;

/** Feeds a steady rate for `seconds`, one reading a second, starting at `from` seconds. */
function steady(estimate: TimeLeft, options: { from: number; seconds: number; bytesPerSecond: number; sent: number; total: number }) {
  let sent = options.sent;
  for (let second = 1; second <= options.seconds; second += 1) {
    sent += options.bytesPerSecond;
    estimate.sample((options.from + second) * 1000, sent, options.total - sent);
  }
  return sent;
}

describe("the time left", () => {
  it("is in plain, rounded words", () => {
    expect(timeLeftWords(20)).toBe("less than a minute left");
    expect(timeLeftWords(70)).toBe("about a minute left");
    expect(timeLeftWords(100)).toBe("about 2 minutes left");
    expect(timeLeftWords(14 * 60 + 40)).toBe("about 15 minutes left");
    expect(timeLeftWords(65 * 60)).toBe("about an hour left");
    expect(timeLeftWords(150 * 60)).toBe("about 3 hours left");
  });

  it("waits for a few seconds of sending before it guesses", () => {
    const estimate = new TimeLeft();
    estimate.sample(0, 0, 200 * MEGABYTE);
    estimate.sample(1000, 3 * MEGABYTE, 197 * MEGABYTE);
    expect(estimate.seconds()).toBeNull();
    expect(estimate.words(1000)).toBeNull();
  });

  it("follows the measured rate: 211 MB at about 3.5 MB/s is about a minute", () => {
    const estimate = new TimeLeft();
    estimate.sample(0, 0, 211 * MEGABYTE);
    steady(estimate, { from: 0, seconds: 10, bytesPerSecond: 3.5 * MEGABYTE, sent: 0, total: 211 * MEGABYTE });
    // 176 MB left at 3.5 MB/s.
    expect(estimate.seconds()).toBeGreaterThan(45);
    expect(estimate.seconds()).toBeLessThan(55);
    expect(estimate.words(10_000)).toBe("about a minute left");
  });

  it("is smoothed: a few slow seconds move it a little, not all the way", () => {
    const estimate = new TimeLeft();
    const total = 600 * MEGABYTE;
    estimate.sample(0, 0, total);
    let sent = steady(estimate, { from: 0, seconds: 20, bytesPerSecond: 2 * MEGABYTE, sent: 0, total });
    const before = estimate.seconds() as number;
    // Two seconds of nothing (a part retrying) must not send the estimate to the moon.
    sent = steady(estimate, { from: 20, seconds: 2, bytesPerSecond: 0, sent, total });
    const after = estimate.seconds() as number;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThan(before * 1.6);
    expect(sent).toBe(40 * MEGABYTE);
  });

  it("changes its words at most every few seconds, so they don't flicker", () => {
    const estimate = new TimeLeft({ holdMs: 6_000 });
    const total = 400 * MEGABYTE;
    estimate.sample(0, 0, total);
    let sent = steady(estimate, { from: 0, seconds: 10, bytesPerSecond: 2 * MEGABYTE, sent: 0, total });
    const first = estimate.words(10_000);
    expect(first).toBe("about 3 minutes left");
    // Faster now: the estimate falls, but the words hold for a moment before they follow.
    sent = steady(estimate, { from: 10, seconds: 3, bytesPerSecond: 8 * MEGABYTE, sent, total });
    expect(estimate.words(13_000)).toBe(first);
    steady(estimate, { from: 13, seconds: 5, bytesPerSecond: 8 * MEGABYTE, sent, total });
    expect(estimate.words(18_000)).not.toBe(first);
  });

  it("starts again from nothing once reset", () => {
    const estimate = new TimeLeft();
    estimate.sample(0, 0, 100 * MEGABYTE);
    steady(estimate, { from: 0, seconds: 10, bytesPerSecond: MEGABYTE, sent: 0, total: 100 * MEGABYTE });
    expect(estimate.seconds()).not.toBeNull();
    estimate.reset();
    expect(estimate.seconds()).toBeNull();
  });
});
