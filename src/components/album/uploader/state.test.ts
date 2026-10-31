import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIZE_LIMITS } from "@/lib/media/limits";
import {
  BIG_FILE_BYTES,
  createUploadStore,
  returnNoticeWords,
  thumbOf,
  UPLOAD_WORDS,
  type UploadFailure,
  type UploadSource,
} from "./state";

/** A picked file as the store sees it: a name, a type and a size (no bytes are read here). */
function picked(name: string, type: string, size = 3_000_000): File {
  return { name, type, size, lastModified: 0 } as File;
}

function storeWithPreviews() {
  const revoked: string[] = [];
  let made = 0;
  const store = createUploadStore({
    previews: {
      create: () => `blob:preview-${(made += 1)}`,
      revoke: (url) => revoked.push(url),
    },
  });
  return { store, revoked };
}

function pick(store: ReturnType<typeof createUploadStore>, source: UploadSource, ...files: File[]) {
  return store.add(files, source);
}

describe("the upload store", () => {
  it("queues each picked file as Waiting to send, in pick order, with its own preview", () => {
    const { store } = storeWithPreviews();
    pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.mov", "video/quicktime"));

    const { items } = store.getSnapshot();
    expect(items.map((item) => [item.file.name, item.status, item.kind, item.previewUrl])).toEqual([
      ["a.jpg", "queued", "photo", "blob:preview-1"],
      ["b.mov", "queued", "video", "blob:preview-2"],
    ]);
  });

  it("turns a file over its limit away before it sends, with gate A's words and no Try again", () => {
    const { store } = storeWithPreviews();
    const queued = pick(
      store,
      "gallery",
      picked("long.mp4", "video/mp4", SIZE_LIMITS.video + 1),
      picked("huge.jpg", "image/jpeg", SIZE_LIMITS.photo + 1),
      picked("fine.mp4", "video/mp4", SIZE_LIMITS.video),
    );

    expect(queued.map((item) => item.file.name)).toEqual(["fine.mp4"]);
    const [video, photo] = store.getSnapshot().items;
    expect(video).toMatchObject({
      status: "failed",
      failure: { reason: "This file is over 2 GB", hint: "Trim it in your gallery, then choose it again.", canRetry: false },
    });
    expect(photo).toMatchObject({ status: "failed", failure: { reason: "This file is over 50 MB", canRetry: false } });
  });

  it("turns away a file the album doesn't take, or an empty one, in the upload API's own words", () => {
    const { store } = storeWithPreviews();
    pick(store, "gallery", picked("notes.pdf", "application/pdf"), picked("empty.jpg", "image/jpeg", 0));

    const [document, empty] = store.getSnapshot().items;
    expect(document.failure).toEqual({ reason: "Only photos and videos can be shared here.", hint: null, canRetry: false });
    expect(empty.failure?.reason).toMatch(/This file is empty/);
  });

  it("takes a HEIC the phone gave no type, and a video it typed by an older name", () => {
    const { store } = storeWithPreviews();
    const queued = pick(store, "gallery", picked("IMG_0001.HEIC", ""), picked("clip.m4v", "video/x-m4v"));

    expect(queued.map((item) => [item.contentType, item.kind])).toEqual([
      ["image/heic", "photo"],
      ["video/mp4", "video"],
    ]);
  });

  it("shows one shot from the camera on the camera card, and anything else as a batch", () => {
    const { store } = storeWithPreviews();
    expect(store.getSnapshot().view).toEqual({ kind: "none" });

    const [shot] = pick(store, "photo", picked("photo.jpg", "image/jpeg"));
    expect(store.getSnapshot().view).toEqual({ kind: "camera", item: shot });

    // A second shot while the first still sends: both show, as a batch.
    pick(store, "video", picked("clip.mp4", "video/mp4"));
    expect(store.getSnapshot().view).toMatchObject({ kind: "batch", total: 2, sent: 0, busy: true });

    const gallery = createUploadStore({ previews: { create: () => null, revoke: () => {} } });
    pick(gallery, "gallery", picked("one.jpg", "image/jpeg"));
    expect(gallery.getSnapshot().view).toMatchObject({ kind: "batch", total: 1 });
  });

  it("counts a batch's sent files and its bytes, and is no longer busy once every file has settled", () => {
    const { store } = storeWithPreviews();
    const [small, large] = pick(store, "gallery", picked("a.jpg", "image/jpeg", 1_000_000), picked("b.mp4", "video/mp4", 3_000_000));

    store.update(small.id, { status: "added", percent: 100 });
    store.update(large.id, { status: "sending", percent: 50 });
    expect(store.getSnapshot().view).toMatchObject({ kind: "batch", sent: 1, total: 2, busy: true, percent: 63 });

    store.update(large.id, { status: "failed", percent: 0, failure: { reason: UPLOAD_WORDS.unreadable, hint: null, canRetry: true } });
    expect(store.getSnapshot().view).toMatchObject({ sent: 1, total: 2, busy: false });
  });

  it("fills the overall bar to the end with a file over its limit in the batch, still counting it in N of M", () => {
    const { store } = storeWithPreviews();
    const [photo] = pick(store, "gallery", picked("a.jpg", "image/jpeg", 1_000_000), picked("long.mp4", "video/mp4", SIZE_LIMITS.video + 1));

    store.update(photo.id, { status: "sending", percent: 50 });
    expect(store.getSnapshot().view).toMatchObject({ percent: 50, sent: 0, total: 2, busy: true });
    store.update(photo.id, { status: "added", percent: 100 });
    expect(store.getSnapshot().view).toMatchObject({ percent: 100, sent: 1, total: 2, busy: false });
  });

  it("leaves a file waiting for Try again out of the bar until it is tried again", () => {
    const { store } = storeWithPreviews();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg", 1_000_000), picked("b.jpg", "image/jpeg", 1_000_000));
    store.update(first.id, { status: "sending", percent: 80 });
    store.update(second.id, { status: "failed", failure: { reason: UPLOAD_WORDS.unreadable, hint: null, canRetry: true } });
    expect(store.getSnapshot().view).toMatchObject({ percent: 80 });

    store.update(second.id, { status: "queued", percent: 0, failure: null });
    expect(store.getSnapshot().view).toMatchObject({ percent: 40 });
  });

  it("takes a file being cancelled off the card at once, and keeps it through a new pick until the server answers", () => {
    const { store } = storeWithPreviews();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "cancelling" });
    expect(store.getSnapshot().view).toMatchObject({ kind: "batch", total: 1, sent: 1, busy: false });

    pick(store, "photo", picked("c.jpg", "image/jpeg"));
    expect(store.getSnapshot().items.map((item) => item.file.name)).toEqual(["b.jpg", "c.jpg"]);
    expect(store.getSnapshot().view).toMatchObject({ kind: "camera" });
  });

  it("starts afresh with a new pick once nothing is sending: added files leave, ones to try again stay", () => {
    const { store, revoked } = storeWithPreviews();
    const [added, retryable, refused] = pick(
      store,
      "gallery",
      picked("a.jpg", "image/jpeg"),
      picked("b.jpg", "image/jpeg"),
      picked("c.jpg", "image/jpeg"),
    );
    store.update(added.id, { status: "added", percent: 100 });
    store.update(retryable.id, { status: "failed", failure: { reason: UPLOAD_WORDS.unreadable, hint: null, canRetry: true } });
    store.update(refused.id, { status: "failed", failure: { reason: "Only photos and videos can be shared here.", hint: null, canRetry: false } });

    const [next] = pick(store, "photo", picked("d.jpg", "image/jpeg"));

    expect(store.getSnapshot().items.map((item) => item.id)).toEqual([retryable.id, next.id]);
    expect(revoked).toEqual([added.previewUrl, refused.previewUrl]);
  });

  it("adds to the batch while files are still sending", () => {
    const { store } = storeWithPreviews();
    const [first] = pick(store, "gallery", picked("a.jpg", "image/jpeg"));
    store.update(first.id, { status: "sending", percent: 10 });
    pick(store, "gallery", picked("b.jpg", "image/jpeg"));

    expect(store.getSnapshot().items).toHaveLength(2);
  });

  it("offers the personal link once a first file has been added, and keeps offering it", () => {
    const { store } = storeWithPreviews();
    const [first] = pick(store, "photo", picked("a.jpg", "image/jpeg"));
    store.update(first.id, { status: "confirming", percent: 100 });
    expect(store.getSnapshot().showLinkOffer).toBe(false);

    store.update(first.id, { status: "added" });
    expect(store.getSnapshot().showLinkOffer).toBe(true);
    store.remove(first.id);
    expect(store.getSnapshot().showLinkOffer).toBe(true);
  });

  it("tells its listeners about each change, gives the same snapshot until one, and forgets a removed file's preview", () => {
    const { store, revoked } = storeWithPreviews();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const [item] = pick(store, "photo", picked("a.jpg", "image/jpeg"));
    const snapshot = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snapshot);

    store.update(item.id, { status: "sending", percent: 5 });
    expect(store.getSnapshot()).not.toBe(snapshot);
    store.remove(item.id);
    unsubscribe();
    store.add([picked("b.jpg", "image/jpeg")], "photo");

    expect(calls).toBe(3);
    expect(revoked).toEqual([item.previewUrl]);
  });
});

const MEBIBYTE = 1024 * 1024;

describe("Ruling BC: a finished card tidies itself away", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function tidyingStore(reducedMotion = false) {
    const revoked: string[] = [];
    let made = 0;
    const store = createUploadStore({
      previews: { create: () => `blob:preview-${(made += 1)}`, revoke: (url) => revoked.push(url) },
      tidy: { batchMs: 5_000, cameraMs: 15_000, fadeMs: 400 },
      reducedMotion: () => reducedMotion,
    });
    return { store, revoked };
  }

  it("shows a batch where every file is Added for about 5 s, then fades it and takes it away", () => {
    const { store, revoked } = tidyingStore();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    vi.advanceTimersByTime(4_000);
    store.update(second.id, { status: "added", percent: 100 });
    expect(store.getSnapshot().view).toMatchObject({ kind: "batch", sent: 2, total: 2, busy: false });

    vi.advanceTimersByTime(4_900);
    expect(store.getSnapshot().items.map((item) => item.leaving)).toEqual([false, false]);
    vi.advanceTimersByTime(100);
    // Fading: still on the card, marked as leaving.
    expect(store.getSnapshot().items.map((item) => item.leaving)).toEqual([true, true]);
    vi.advanceTimersByTime(400);
    expect(store.getSnapshot().items).toEqual([]);
    expect(store.getSnapshot().view).toEqual({ kind: "none" });
    expect(revoked).toEqual(["blob:preview-1", "blob:preview-2"]);
    // The personal link stays offered: its card goes only when the guest hides it.
    expect(store.getSnapshot().showLinkOffer).toBe(true);
  });

  it("with reduced motion, takes the card away at once, with no fade", () => {
    const { store } = tidyingStore(true);
    const [first] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg", 0));
    store.update(first.id, { status: "added", percent: 100 });

    vi.advanceTimersByTime(4_999);
    expect(store.getSnapshot().items).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().items.some((item) => item.leaving)).toBe(false);
    expect(store.getSnapshot().items.map((item) => item.file.name)).toEqual(["b.jpg"]);
  });

  it("with failures, fades the Added rows and keeps the failed ones, still counting what was sent", () => {
    const { store } = tidyingStore();
    const [first, second, third] = pick(
      store,
      "gallery",
      picked("a.jpg", "image/jpeg"),
      picked("b.jpg", "image/jpeg"),
      picked("c.jpg", "image/jpeg"),
    );
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "added", percent: 100 });
    store.update(third.id, { status: "failed", failure: { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true } });

    vi.advanceTimersByTime(5_400);
    expect(store.getSnapshot().items.map((item) => item.file.name)).toEqual(["c.jpg"]);
    expect(store.getSnapshot().view).toMatchObject({ kind: "batch", sent: 2, total: 3, busy: false });

    // Tried again and added, it is shown, then tidied too.
    store.update(third.id, { status: "sending", failure: null });
    vi.advanceTimersByTime(10_000);
    expect(store.getSnapshot().items).toHaveLength(1);
    store.update(third.id, { status: "added", percent: 100 });
    expect(store.getSnapshot().view).toMatchObject({ sent: 3, total: 3 });
    vi.advanceTimersByTime(5_400);
    expect(store.getSnapshot().view).toEqual({ kind: "none" });
  });

  it("never tidies while a file is still on its way", () => {
    const { store } = tidyingStore();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "sending", percent: 30 });
    vi.advanceTimersByTime(60_000);
    expect(store.getSnapshot().items).toHaveLength(2);
    expect(store.getSnapshot().items.some((item) => item.leaving)).toBe(false);
  });

  it("tidies the camera card after about 15 s if the guest does nothing", () => {
    const { store } = tidyingStore();
    const [shot] = pick(store, "photo", picked("a.jpg", "image/jpeg"));
    store.update(shot.id, { status: "added", percent: 100 });

    vi.advanceTimersByTime(14_000);
    expect(store.getSnapshot().view).toMatchObject({ kind: "camera" });
    vi.advanceTimersByTime(1_400);
    expect(store.getSnapshot().view).toEqual({ kind: "none" });
  });

  it("starts counting the next batch afresh", () => {
    const { store } = tidyingStore();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "failed", failure: { reason: "Only photos and videos can be shared here.", hint: null, canRetry: false } });
    vi.advanceTimersByTime(5_400);
    expect(store.getSnapshot().view).toMatchObject({ sent: 1, total: 2 });

    pick(store, "gallery", picked("c.jpg", "image/jpeg"));
    expect(store.getSnapshot().view).toMatchObject({ sent: 0, total: 1 });
  });
});

describe("Ruling BA: a file that changed after it was picked", () => {
  const changed: UploadFailure = { reason: "This photo changed after you chose it", hint: "Choose it again.", canRetry: false, chooseAgain: true };

  it("gives way to the same file chosen again in its place, even while others still send", () => {
    const { store } = storeWithPreviews();
    const [sending, stale] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("IMG-WA0007.jpg", "image/jpeg"));
    store.update(sending.id, { status: "sending", percent: 20 });
    store.update(stale.id, { status: "failed", failure: changed });

    const [again] = store.add([picked("IMG-WA0007.jpg", "image/jpeg")], "gallery", { replacing: stale.id });
    expect(store.getSnapshot().items.map((item) => item.id)).toEqual([sending.id, again.id]);
    expect(again.status).toBe("queued");
  });
});

describe("Ruling BE: minimising, and the notice for a big or slow upload", () => {
  it("minimises the card while files send, opens it again for a new pick, and forgets it once the card is gone", () => {
    const { store } = storeWithPreviews();
    const [first] = pick(store, "gallery", picked("a.jpg", "image/jpeg"));
    store.setMinimised(true);
    expect(store.getSnapshot().minimised).toBe(true);

    pick(store, "gallery", picked("b.jpg", "image/jpeg"));
    expect(store.getSnapshot().minimised).toBe(false);

    store.setMinimised(true);
    for (const item of store.getSnapshot().items) store.remove(item.id);
    expect(first).toBeDefined();
    expect(store.getSnapshot().minimised).toBe(false);
  });

  it("says a big video may take a few minutes, for a file over about 100 MB, whatever the time left", () => {
    const { store } = storeWithPreviews();
    const [small] = pick(store, "gallery", picked("a.mp4", "video/mp4", BIG_FILE_BYTES));
    expect(store.getSnapshot().notice).toBeNull();
    store.remove(small.id);

    pick(store, "video", picked("speeches.mp4", "video/mp4", BIG_FILE_BYTES + 1));
    expect(BIG_FILE_BYTES).toBe(100 * MEBIBYTE);
    expect(store.getSnapshot().notice).toBe(
      "This is a big video, so it may take a few minutes on mobile data. You can minimise this and keep looking through the album; just keep this page open.",
    );
    pick(store, "gallery", picked("b.jpg", "image/jpeg"));
    expect(store.getSnapshot().notice).toBe(
      "There's a big video in these, so they may take a few minutes on mobile data. You can minimise this and keep looking through the album; just keep this page open.",
    );
  });

  it("says it may take a few minutes once the time left passes about a minute, keeping the notice until the files have sent", () => {
    const { store } = storeWithPreviews();
    const [only] = pick(store, "gallery", picked("a.jpg", "image/jpeg"));
    store.setTimeLeft({ seconds: 59, words: "about a minute left" });
    expect(store.getSnapshot().notice).toBeNull();
    expect(store.getSnapshot().timeLeft).toBeNull();

    store.setTimeLeft({ seconds: 61, words: "about a minute left" });
    expect(store.getSnapshot().notice).toBe(
      "This may take a few minutes on mobile data. You can minimise this and keep looking through the album; just keep this page open.",
    );
    expect(store.getSnapshot().timeLeft).toBe("about a minute left");

    // It doesn't come and go as the estimate moves.
    store.setTimeLeft({ seconds: 40, words: "less than a minute left" });
    expect(store.getSnapshot().notice).not.toBeNull();
    expect(store.getSnapshot().timeLeft).toBe("less than a minute left");

    store.update(only.id, { status: "added", percent: 100 });
    expect(store.getSnapshot().notice).toBeNull();
    expect(store.getSnapshot().timeLeft).toBeNull();
  });
});

describe("Ruling BB: a thumbnail the phone can't draw", () => {
  it("shows the guest's own picture, else the server's once it has one, else a photo or video icon", () => {
    const { store } = storeWithPreviews();
    const [photo, video] = pick(store, "gallery", picked("IMG_0001.HEIC", "image/heic"), picked("clip.mov", "video/quicktime"));
    expect(thumbOf(photo, false)).toEqual({ kind: "local", url: "blob:preview-1" });
    expect(thumbOf(photo, true)).toEqual({ kind: "icon", icon: "image" });
    expect(thumbOf(video, true)).toEqual({ kind: "icon", icon: "video" });
    expect(thumbOf({ ...photo, previewUrl: null }, false)).toEqual({ kind: "icon", icon: "image" });
    // Task 15's seam: once the server has made its thumbnail, that shows instead of the icon.
    expect(thumbOf({ ...photo, serverThumbUrl: "https://media.example/thumb.webp" }, true)).toEqual({
      kind: "server",
      url: "https://media.example/thumb.webp",
    });
  });
});

describe("the notice on return", () => {
  it("names what didn't finish sending, and how to carry it on", () => {
    expect(returnNoticeWords([])).toBeNull();
    expect(returnNoticeWords([{ kind: "video" }])).toBe("Your video didn't finish sending. Choose it again and it'll carry on from where it stopped.");
    expect(returnNoticeWords([{ kind: "photo" }])).toBe("Your photo didn't finish sending. Choose it again and it'll carry on from where it stopped.");
    expect(returnNoticeWords([{ kind: null }])).toBe("One of your files didn't finish sending. Choose it again and it'll carry on from where it stopped.");
    expect(returnNoticeWords([{ kind: "video" }, { kind: "video" }])).toBe(
      "2 of your videos didn't finish sending. Choose them again and they'll carry on from where they stopped.",
    );
    expect(returnNoticeWords([{ kind: "video" }, { kind: "photo" }, { kind: null }])).toBe(
      "3 of your files didn't finish sending. Choose them again and they'll carry on from where they stopped.",
    );
  });
});
