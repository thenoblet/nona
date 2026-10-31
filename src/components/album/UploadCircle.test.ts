import { describe, expect, it } from "vitest";
import { circleOf } from "./UploadCircle";
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

describe("the floating progress circle", () => {
  it("shows a single file's percentage, and for several the number still to send", () => {
    const { store } = storeWithPreviews();
    const [shot] = pick(store, "photo", picked("a.jpg", "image/jpeg", 1_000_000));
    store.update(shot.id, { status: "sending", percent: 42 });
    expect(circleOf(store.getSnapshot())).toEqual({ percent: 42, centre: "42%", failed: false, done: false, label: "Show uploads, 42% sent" });

    const [second, third] = pick(store, "gallery", picked("b.jpg", "image/jpeg", 1_000_000), picked("c.jpg", "image/jpeg", 2_000_000));
    store.update(second.id, { status: "added", percent: 100 });
    store.update(third.id, { status: "sending", percent: 25 });
    expect(circleOf(store.getSnapshot())).toMatchObject({ percent: 48, centre: "2", failed: false, done: false, label: "Show uploads, 48% sent" });
  });

  it("turns to done once everything has sent, and shows a failure until the card is opened", () => {
    const { store } = storeWithPreviews();
    const [first, second] = pick(store, "gallery", picked("a.jpg", "image/jpeg"), picked("b.jpg", "image/jpeg"));
    store.update(first.id, { status: "added", percent: 100 });
    store.update(second.id, { status: "failed", failure: { reason: UPLOAD_WORDS.connectionDropped, hint: null, canRetry: true } });
    expect(circleOf(store.getSnapshot())).toMatchObject({ centre: "1", failed: true, done: false, label: "Show uploads, 1 didn't send" });

    store.update(second.id, { status: "added", percent: 100, failure: null });
    expect(circleOf(store.getSnapshot())).toMatchObject({ percent: 100, failed: false, done: true, label: "Show uploads, all sent" });
  });
});

