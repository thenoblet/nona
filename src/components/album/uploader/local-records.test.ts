import { describe, expect, it } from "vitest";
import { createPendingCancels, createStartedFiles, subscribeToStartedFiles, type StorageLike } from "./local-records";
import { createSentFiles, forgetMedia } from "./resume";

function memoryStorage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
}

const blocked: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const DAY = 24 * 60 * 60 * 1000;

describe("the uploads this phone started", () => {
  it("are unfinished from their start until they finish, across page loads", () => {
    const storage = memoryStorage();
    createStartedFiles(storage).record(5000, "f1", "media-1", { now: 1_000 });

    const later = createStartedFiles(storage);
    expect(later.hasUnfinished(2_000)).toBe(true);
    later.finish(5000, "f1");
    expect(createStartedFiles(storage).hasUnfinished(2_000)).toBe(false);
  });

  it("stop counting after seven days, when R2 has let the upload go", () => {
    const storage = memoryStorage();
    createStartedFiles(storage).record(5000, "f1", "media-1", { now: 0 });

    expect(createStartedFiles(storage).hasUnfinished(6 * DAY)).toBe(true);
    expect(createStartedFiles(storage).hasUnfinished(8 * DAY)).toBe(false);
  });

  it("are forgotten by upload, and remember nothing when storage is blocked", () => {
    const storage = memoryStorage();
    const started = createStartedFiles(storage);
    started.record(1, "a", "media-a", { now: 0 });
    started.record(2, "b", "media-b", { now: 0 });
    started.forgetMedia("media-a");
    started.finish(2, "b");
    expect(started.hasUnfinished(1)).toBe(false);

    const nowhere = createStartedFiles(blocked);
    expect(() => nowhere.record(1, "a", "m")).not.toThrow();
    expect(nowhere.hasUnfinished()).toBe(false);
  });
});

describe("the uploads this phone started, for the notice on return", () => {
  it("list what each unfinished upload was, a photo or a video, for seven days", () => {
    const storage = memoryStorage();
    const started = createStartedFiles(storage);
    started.record(5000, "f1", "media-1", { now: 0, kind: "video" });
    started.record(6000, "f2", "media-2", { now: 1, kind: "photo" });
    // One recorded before uploads said what they were.
    storage.values.set("nona:started-files", JSON.stringify({ ...JSON.parse(storage.values.get("nona:started-files") ?? "{}"), "7000:f3": { mediaId: "media-3", at: 2 } }));

    expect(createStartedFiles(storage).unfinished(DAY)).toEqual([
      { mediaId: "media-1", kind: "video", at: 0 },
      { mediaId: "media-2", kind: "photo", at: 1 },
      { mediaId: "media-3", kind: null, at: 2 },
    ]);
    expect(createStartedFiles(storage).unfinished(8 * DAY)).toEqual([]);
  });

  it("tell the page each time they change, so the notice goes once the upload finishes", () => {
    const storage = memoryStorage();
    const changes: number[] = [];
    const unsubscribe = subscribeToStartedFiles(() => changes.push(changes.length));
    const started = createStartedFiles(storage);
    started.record(5000, "f1", "media-1", { kind: "video" });
    started.finish(5000, "f1");
    started.finish(5000, "f1");
    unsubscribe();
    started.record(6000, "f2", "media-2");

    expect(changes).toEqual([0, 1]);
  });
});

describe("the Cancels not yet answered", () => {
  it("are kept by upload until the server answers, across page loads", () => {
    const storage = memoryStorage();
    createPendingCancels(storage).add("media-1", "upload-1", 5);
    createPendingCancels(storage).add("media-2", null, 6);

    expect(createPendingCancels(storage).list(10)).toEqual([
      { mediaId: "media-1", uploadId: "upload-1", at: 5 },
      { mediaId: "media-2", uploadId: null, at: 6 },
    ]);
    createPendingCancels(storage).remove("media-1");
    expect(createPendingCancels(storage).list(10).map((cancel) => cancel.mediaId)).toEqual(["media-2"]);
  });

  it("are dropped after seven days, so none is sent for ever", () => {
    const storage = memoryStorage();
    createPendingCancels(storage).add("media-old", null, 0);
    createPendingCancels(storage).add("media-new", null, 6 * DAY);

    expect(createPendingCancels(storage).list(8 * DAY).map((cancel) => cancel.mediaId)).toEqual(["media-new"]);
    // Gone from storage too, not just from the list.
    expect(createPendingCancels(storage).list(6 * DAY).map((cancel) => cancel.mediaId)).toEqual(["media-new"]);
  });

  it("carry on, keeping nothing, when storage is blocked or holds something it can't read", () => {
    const cancels = createPendingCancels(blocked);
    expect(() => cancels.add("media-1", null)).not.toThrow();
    expect(cancels.list()).toEqual([]);

    const corrupt = memoryStorage();
    corrupt.setItem("nona:pending-cancels", "[1, 2");
    expect(createPendingCancels(corrupt).list()).toEqual([]);
  });
});

describe("forgetMedia", () => {
  it("forgets a removed upload's file, so the same file picked again is sent afresh", () => {
    const storage = memoryStorage();
    createSentFiles(storage).remember(5000, "f1", "media-1");
    createSentFiles(storage).remember(6000, "f2", "media-2");
    createStartedFiles(storage).record(5000, "f1", "media-1");

    forgetMedia("media-1", storage);

    expect(createSentFiles(storage).find(5000, "f1")).toBeNull();
    expect(createSentFiles(storage).find(6000, "f2")).toBe("media-2");
    expect(createStartedFiles(storage).hasUnfinished()).toBe(false);
  });
});
