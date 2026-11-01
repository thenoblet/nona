import { afterEach, describe, expect, it, vi } from "vitest";
import { circleOf, milestoneOf, ringOf } from "./UploadCircle";
import { createUploadStore, UPLOAD_WORDS } from "./uploader/state";

/*
 * What the floating progress circle shows of the card it stands in for (Ruling BE): the ring's share
 * sent, a single file's percentage or how many files are still to arrive, a failure, the end.
 */

/** A picked file as the store sees it: a name, a type and a size (no bytes are read here). */
function picked(name: string, type: string, size = 3_000_000): File {
  return { name, type, size, lastModified: 0 } as File;
}

function storeWithPreviews() {
  const store = createUploadStore({ previews: { create: () => null, revoke: () => {} } });
  return { store };
}

function pick(store: ReturnType<typeof createUploadStore>, source: "photo" | "video" | "gallery", ...files: File[]) {
  return store.add(files, source);
}

const connectionDropped = { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true };

describe("the floating progress circle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a single file's percentage, and for several only how many are still sending", () => {
    const { store } = storeWithPreviews();
    const [shot] = pick(store, "photo", picked("a.jpg", "image/jpeg", 1_000_000));
    store.update(shot.id, { status: "sending", percent: 42 });
    expect(circleOf(store.getSnapshot())).toEqual({
      percent: 42,
      centre: "42%",
      failedCount: 0,
      sending: true,
      done: false,
      label: "Show uploads, 42% sent",
    });

    const [second, third, fourth] = pick(
      store,
      "gallery",
      picked("b.jpg", "image/jpeg", 1_000_000),
      picked("c.jpg", "image/jpeg", 2_000_000),
      picked("d.jpg", "image/jpeg", 1_000_000),
    );
    store.update(second.id, { status: "added", percent: 100 });
    store.update(third.id, { status: "sending", percent: 25 });
    store.update(fourth.id, { status: "failed", failure: connectionDropped });
    // Two still sending (the photo and c.jpg); the failure is the error state's to say, not the count's.
    expect(circleOf(store.getSnapshot())).toMatchObject({
      percent: 48,
      centre: "2",
      failedCount: 1,
      sending: true,
      label: "Show uploads, 48% sent, 1 didn't send",
    });
  });

  it("turns to done once everything has sent, and with only a failure left says so without a percentage", () => {
    const { store } = storeWithPreviews();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "failed", failure: connectionDropped });
    const failedCircle = circleOf(store.getSnapshot());
    expect(failedCircle).toMatchObject({ centre: "", failedCount: 1, sending: false, done: false, label: "Show uploads, 1 didn't send" });
    expect(milestoneOf(failedCircle!)).toBe("1 didn't send; open your uploads to see.");

    store.update(second.id, { status: "added", percent: 100, failure: null });
    const doneCircle = circleOf(store.getSnapshot());
    expect(doneCircle).toMatchObject({ percent: 100, failedCount: 0, done: true, label: "Show uploads, all sent" });
    expect(milestoneOf(doneCircle!)).toBe("All your files have arrived.");
  });

  it("keeps counting the files that arrived once they tidy away, so a failure left behind never drops the ring to 0%", () => {
    vi.useFakeTimers();
    const store = createUploadStore({ previews: { create: () => null, revoke: () => {} }, tidy: { batchMs: 5_000, fadeMs: 400 }, reducedMotion: () => false });
    const [arrived, failed] = pick(store, "gallery", picked("a.jpg", "image/jpeg", 1_000_000), picked("b.jpg", "image/jpeg", 2_000_000));
    store.update(arrived.id, { status: "added", percent: 100 });
    store.update(failed.id, { status: "failed", failure: connectionDropped });
    expect(circleOf(store.getSnapshot())?.percent).toBe(100);

    vi.advanceTimersByTime(5_400);
    expect(store.getSnapshot().items.map((item) => item.file.name)).toEqual(["b.jpg"]);
    expect(circleOf(store.getSnapshot())).toMatchObject({ percent: 100, failedCount: 1, sending: false });

    // Tried again, halfway: a.jpg's 1 MB and half of b.jpg's 2 MB of 3 MB.
    store.update(failed.id, { status: "sending", percent: 50, failure: null });
    expect(circleOf(store.getSnapshot())).toMatchObject({ percent: 67, centre: "1", failedCount: 0, sending: true });
    expect(milestoneOf(circleOf(store.getSnapshot())!)).toBe("Uploads: 50% sent.");
  });

  it("turns the ring red on a failure, filling on with the others' bytes while they send, and full once none is", () => {
    const { store } = storeWithPreviews();
    const [video, photo] = pick(store, "gallery", picked("clip.mp4", "video/mp4", 3_000_000), picked("a.jpg", "image/jpeg", 1_000_000));
    store.update(video.id, { status: "sending", percent: 30 });
    // 0.9 MB of the 4 MB on their way.
    expect(ringOf(circleOf(store.getSnapshot())!)).toEqual({ filled: 23, tone: "ember" });

    // The photo fails before a byte: red at once, still filling with the video's progress (its 0.9 MB of 3 MB).
    store.update(photo.id, { status: "failed", failure: connectionDropped });
    expect(ringOf(circleOf(store.getSnapshot())!)).toEqual({ filled: 30, tone: "alert" });
    store.update(video.id, { status: "sending", percent: 60 });
    expect(ringOf(circleOf(store.getSnapshot())!)).toEqual({ filled: 60, tone: "alert" });

    // Nothing left sending: a full red ring.
    store.update(video.id, { status: "added", percent: 100 });
    expect(ringOf(circleOf(store.getSnapshot())!)).toEqual({ filled: 100, tone: "alert" });
  });

  it("gives a lone file that failed before its first byte a full red ring, not an empty one", () => {
    const { store } = storeWithPreviews();
    const [shot] = pick(store, "photo", picked("a.jpg", "image/jpeg", 1_000_000));
    store.update(shot.id, { status: "failed", failure: connectionDropped });
    const circle = circleOf(store.getSnapshot())!;
    expect(circle).toMatchObject({ percent: 0, sending: false, failedCount: 1 });
    expect(ringOf(circle)).toEqual({ filled: 100, tone: "alert" });
  });
});
