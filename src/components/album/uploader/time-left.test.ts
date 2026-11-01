import { describe, expect, it } from "vitest";
import { TimeLeft, timeLeftWords, type TimeLeftEstimate } from "./time-left";

/*
 * The calm estimate of the time a big upload has left (Ruling BE): from the bytes measured going
 * out, smoothed, in words that don't jump about, and never a guess drawn out of a stall.
 */

const MEGABYTE = 1_000_000;

/** Reads once a second at a steady rate for `seconds`, from `from` seconds; returns the bytes sent and the last estimate. */
function steady(
  estimate: TimeLeft,
  options: { from: number; seconds: number; bytesPerSecond: number; sent: number; total: number; held?: boolean },
): { sent: number; last: TimeLeftEstimate | null } {
  let sent = options.sent;
  let last: TimeLeftEstimate | null = null;
  for (let second = 1; second <= options.seconds; second += 1) {
    sent += options.bytesPerSecond;
    last = estimate.read((options.from + second) * 1000, { sentBytes: sent, remainingBytes: options.total - sent, held: options.held ?? false });
  }
  return { sent, last };
}

describe("the time left", () => {
  it("is in plain, rounded words, and past half an hour only says it may take a while", () => {
    expect(timeLeftWords(20)).toBe("less than a minute left");
    expect(timeLeftWords(70)).toBe("about a minute left");
    expect(timeLeftWords(100)).toBe("about 2 minutes left");
    expect(timeLeftWords(14 * 60 + 40)).toBe("about 15 minutes left");
    expect(timeLeftWords(30 * 60)).toBe("about 30 minutes left");
    expect(timeLeftWords(31 * 60)).toBe("this may take a while");
    expect(timeLeftWords(60 * 60 * 60)).toBe("this may take a while");
  });

  it("waits until bytes have moved for a few seconds before it guesses", () => {
    const estimate = new TimeLeft();
    // The start's overhead: nothing out yet, however long.
    for (let second = 0; second <= 10; second += 1) {
      expect(estimate.read(second * 1000, { sentBytes: 0, remainingBytes: 200 * MEGABYTE, held: false })).toBeNull();
    }
    const { last } = steady(estimate, { from: 10, seconds: 2, bytesPerSecond: 3 * MEGABYTE, sent: 0, total: 200 * MEGABYTE });
    expect(last).toBeNull();
    // Moving now, the start's wait never counts against the rate.
    const { last: guess } = steady(estimate, { from: 12, seconds: 3, bytesPerSecond: 3 * MEGABYTE, sent: 6 * MEGABYTE, total: 200 * MEGABYTE });
    expect(guess?.seconds).toBeGreaterThan(55);
    expect(guess?.seconds).toBeLessThan(70);
  });

  it("follows the measured rate: 211 MB at about 3.5 MB/s is about a minute", () => {
    const estimate = new TimeLeft();
    estimate.read(0, { sentBytes: 0, remainingBytes: 211 * MEGABYTE, held: false });
    const { last } = steady(estimate, { from: 0, seconds: 10, bytesPerSecond: 3.5 * MEGABYTE, sent: 0, total: 211 * MEGABYTE });
    // 176 MB left at 3.5 MB/s.
    expect(last?.seconds).toBeGreaterThan(45);
    expect(last?.seconds).toBeLessThan(55);
    expect(last?.words).toBe("about a minute left");
  });

  it("says nothing through a stall, rather than an hour, and carries on from the same rate after it", () => {
    const estimate = new TimeLeft();
    const total = 300 * MEGABYTE;
    estimate.read(0, { sentBytes: 0, remainingBytes: total, held: false });
    let { sent, last } = steady(estimate, { from: 0, seconds: 20, bytesPerSecond: 2 * MEGABYTE, sent: 0, total });
    const before = last?.seconds as number;
    expect(before).toBeGreaterThan(100);
    expect(before).toBeLessThan(150);

    // Thirty seconds and then a minute of nothing: a moment's grace, then no estimate at all.
    const during: (TimeLeftEstimate | null)[] = [];
    for (let second = 21; second <= 110; second += 1) {
      during.push(estimate.read(second * 1000, { sentBytes: sent, remainingBytes: total - sent, held: false }));
    }
    expect(during.slice(3).every((reading) => reading === null)).toBe(true);
    expect(during.filter((reading) => reading !== null).every((reading) => (reading as TimeLeftEstimate).seconds < before * 1.5)).toBe(true);

    // Moving again at the same rate: the same estimate as before the stall, not one stretched by it.
    ({ sent, last } = steady(estimate, { from: 110, seconds: 2, bytesPerSecond: 2 * MEGABYTE, sent, total }));
    expect(last?.seconds).toBeGreaterThan((total - sent) / (2 * MEGABYTE) - 5);
    expect(last?.seconds).toBeLessThan((total - sent) / (2 * MEGABYTE) + 5);
    expect(last?.words).not.toMatch(/hour|while/);
  });

  it("says nothing while a part retries or the phone is offline, even with bytes on the counter", () => {
    const estimate = new TimeLeft();
    estimate.read(0, { sentBytes: 0, remainingBytes: 100 * MEGABYTE, held: false });
    steady(estimate, { from: 0, seconds: 10, bytesPerSecond: MEGABYTE, sent: 0, total: 100 * MEGABYTE });
    const { last } = steady(estimate, { from: 10, seconds: 3, bytesPerSecond: MEGABYTE, sent: 10 * MEGABYTE, total: 100 * MEGABYTE, held: true });
    expect(last).toBeNull();
  });

  it("stops once nothing is left to send", () => {
    const estimate = new TimeLeft();
    estimate.read(0, { sentBytes: 0, remainingBytes: 20 * MEGABYTE, held: false });
    const { last } = steady(estimate, { from: 0, seconds: 10, bytesPerSecond: 2 * MEGABYTE, sent: 0, total: 20 * MEGABYTE });
    expect(last).toBeNull();
  });

  it("is smoothed: a burst of speed moves it, but not all the way at once", () => {
    const estimate = new TimeLeft({ holdMs: 0 });
    const total = 600 * MEGABYTE;
    estimate.read(0, { sentBytes: 0, remainingBytes: total, held: false });
    let { sent, last } = steady(estimate, { from: 0, seconds: 20, bytesPerSecond: 2 * MEGABYTE, sent: 0, total });
    const before = last?.seconds as number;
    ({ sent, last } = steady(estimate, { from: 20, seconds: 2, bytesPerSecond: 8 * MEGABYTE, sent, total }));
    const after = last?.seconds as number;
    expect(after).toBeLessThan(before);
    // At 8 MB/s straight away it would be (total - sent) / 8 MB.
    expect(after).toBeGreaterThan((total - sent) / (8 * MEGABYTE));
  });

  it("changes its words at most every few seconds, so they don't flicker", () => {
    const estimate = new TimeLeft({ holdMs: 6_000 });
    const total = 400 * MEGABYTE;
    estimate.read(0, { sentBytes: 0, remainingBytes: total, held: false });
    let sent = 0;
    const words: string[] = [];
    // A second at a time: 10 s at 2 MB/s, 4 s at 8 MB/s, then 6 s at 1 MB/s.
    for (const [seconds, bytesPerSecond] of [[10, 2], [4, 8], [6, 1]]) {
      for (let second = 0; second < seconds; second += 1) {
        sent += bytesPerSecond * MEGABYTE;
        const reading = estimate.read((words.length + 1) * 1000, { sentBytes: sent, remainingBytes: total - sent, held: false });
        words.push(reading?.words ?? "");
      }
    }
    expect(words[9]).toBe("about 3 minutes left");
    // Each change of words stands for at least 6 s before the next one.
    const changes = words.flatMap((said, index) => (index > 0 && said && words[index - 1] && said !== words[index - 1] ? [index] : []));
    expect(changes.length).toBeGreaterThan(0);
    for (let change = 1; change < changes.length; change += 1) expect(changes[change] - changes[change - 1]).toBeGreaterThanOrEqual(6);
  });

  it("starts again from nothing once reset", () => {
    const estimate = new TimeLeft();
    estimate.read(0, { sentBytes: 0, remainingBytes: 100 * MEGABYTE, held: false });
    const { last } = steady(estimate, { from: 0, seconds: 10, bytesPerSecond: MEGABYTE, sent: 0, total: 100 * MEGABYTE });
    expect(last).not.toBeNull();
    estimate.reset();
    expect(estimate.read(11_000, { sentBytes: 11 * MEGABYTE, remainingBytes: 89 * MEGABYTE, held: false })).toBeNull();
  });
});
