import { describe, expect, it } from "vitest";
import { SIZE_LIMITS } from "@/lib/media/limits";
import { createUploadStore, UPLOAD_WORDS, type UploadSource } from "./state";

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
