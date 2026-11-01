import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPendingCancels,
  createReturnNoticeReader,
  createStartedFiles,
  dismissReturnNotice,
  returnNoticeUploads,
  nextSendingExpiry,
  setSendingHere,
  stillSending,
  stopSayingSending,
  subscribeToReturnNotice,
  subscribeToStartedFiles,
  type StorageLike,
} from "./local-records";
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

describe("what the notice on return speaks of", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function twoUnfinished() {
    const storage = memoryStorage();
    const started = createStartedFiles(storage);
    started.record(5000, "f1", "media-1", { now: 0, kind: "video" });
    started.record(6000, "f2", "media-2", { now: 0, kind: "photo" });
    return storage;
  }

  it("leaves out what the guest set aside (Not now), keeping the records for the grace after a close", () => {
    const storage = twoUnfinished();
    dismissReturnNotice(["media-1", "media-2"], storage, 10);
    expect(returnNoticeUploads(storage, 20)).toEqual([]);
    // The records themselves stay: the closed album's "Finish sending what you started" still reads them.
    expect(createStartedFiles(storage).hasUnfinished(20)).toBe(true);

    // Another upload left unfinished brings the notice back, for that one.
    createStartedFiles(storage).record(7000, "f3", "media-3", { now: 30, kind: "video" });
    expect(returnNoticeUploads(storage, 40).map((upload) => upload.mediaId)).toEqual(["media-3"]);
  });

  it("leaves out an upload this page is still sending, from an uploader left running behind the page", () => {
    const storage = twoUnfinished();
    const olderUploader = {};
    setSendingHere(olderUploader, ["media-1"], storage, 10);
    expect(returnNoticeUploads(storage, 20).map((upload) => upload.mediaId)).toEqual(["media-2"]);
    setSendingHere(olderUploader, [], storage, 30);
    expect(returnNoticeUploads(storage, 40).map((upload) => upload.mediaId)).toEqual(["media-1", "media-2"]);
  });

  it("leaves out an upload another tab is still sending, until that tab has been quiet for 15 s", () => {
    const storage = twoUnfinished();
    // Another tab's record of what it sends, as its uploader wrote it (and an older, bare-time beat).
    storage.values.set("nona:sending-now", JSON.stringify({ "media-2": { at: 1_000, tab: "tab-other" }, "media-1": 900 }));
    expect(returnNoticeUploads(storage, 10_000, "tab-here")).toEqual([]);
    expect(returnNoticeUploads(storage, 16_001, "tab-here").map((upload) => upload.mediaId)).toEqual(["media-1", "media-2"]);
    expect(nextSendingExpiry(storage, 10_000, "tab-here")).toBe(15_900);
  });

  it("ignores its own tab's beats: a page reloaded in the tab offers to carry its upload on at once", () => {
    const storage = twoUnfinished();
    storage.values.set("nona:sending-now", JSON.stringify({ "media-2": { at: 1_000, tab: "tab-here" } }));
    expect(returnNoticeUploads(storage, 2_000, "tab-here").map((upload) => upload.mediaId)).toEqual(["media-1", "media-2"]);
    expect(nextSendingExpiry(storage, 2_000, "tab-here")).toBeNull();
  });

  it("writes what this page sends for other tabs, keeping theirs, and saying so again while it still is", () => {
    const storage = memoryStorage();
    storage.values.set("nona:sending-now", JSON.stringify({ "media-other": { at: 900, tab: "tab-other" }, "media-gone": { at: -20_000, tab: "tab-old" } }));
    const uploader = {};
    setSendingHere(uploader, ["media-9"], storage, 1_000, "tab-here");
    expect(JSON.parse(storage.values.get("nona:sending-now") ?? "{}")).toEqual({
      "media-other": { at: 900, tab: "tab-other" },
      "media-9": { at: 1_000, tab: "tab-here" },
    });
    stillSending(storage, 6_000, "tab-here");
    expect(JSON.parse(storage.values.get("nona:sending-now") ?? "{}")["media-9"]).toEqual({ at: 6_000, tab: "tab-here" });
    setSendingHere(uploader, [], storage, 7_000, "tab-here");
    expect(JSON.parse(storage.values.get("nona:sending-now") ?? "{}")).toEqual({ "media-other": { at: 900, tab: "tab-other" } });
  });

  it("stops saying it sends as the page goes, so the page reloaded offers to carry the upload on at once", () => {
    const storage = twoUnfinished();
    const uploader = {};
    setSendingHere(uploader, ["media-1"], storage, 1_000, "tab-here");
    storage.values.set(
      "nona:sending-now",
      JSON.stringify({ ...JSON.parse(storage.values.get("nona:sending-now") ?? "{}"), "media-2": { at: 1_000, tab: "tab-other" } }),
    );
    stopSayingSending(storage, "tab-here");
    // What the next page reads: only the other tab's beat.
    expect(JSON.parse(storage.values.get("nona:sending-now") ?? "{}")).toEqual({ "media-2": { at: 1_000, tab: "tab-other" } });
    setSendingHere(uploader, [], storage, 2_000, "tab-here");
  });

  it("is read again once another tab's beat goes stale, and the page is told then, not a whole visit later", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const storage = twoUnfinished();
    storage.values.set("nona:sending-now", JSON.stringify({ "media-1": { at: 0, tab: "tab-other" } }));
    let now = 0;
    const read = createReturnNoticeReader(storage, (uploads) => uploads.map((upload) => upload.mediaId), () => now, "tab-here");
    expect(read()).toEqual(["media-2"]);
    let told = 0;
    const unsubscribe = subscribeToReturnNotice(storage, () => {
      told += 1;
    });

    now = 14_000;
    vi.setSystemTime(now);
    vi.advanceTimersByTime(14_000);
    expect(told).toBe(0);
    expect(read()).toEqual(["media-2"]);
    now = 15_100;
    vi.setSystemTime(now);
    vi.advanceTimersByTime(1_100);
    expect(told).toBe(1);
    expect(read()).toEqual(["media-1", "media-2"]);
    unsubscribe();
  });

  it("is read again only when its records change, not on every render while files send", () => {
    const storage = twoUnfinished();
    let reads = 0;
    let now = 1_000;
    const read = createReturnNoticeReader(
      storage,
      (uploads) => {
        reads += 1;
        return uploads.map((upload) => upload.mediaId);
      },
      () => now,
    );
    const first = read();
    for (let tick = 0; tick < 50; tick += 1) {
      now += 100;
      expect(read()).toBe(first);
    }
    expect(reads).toBe(1);
    createStartedFiles(storage).finish(5000, "f1");
    expect(read()).toEqual(["media-2"]);
    expect(reads).toBe(2);
  });

  it("tells the page when the notice's uploads change: set aside, or sending here", () => {
    const storage = twoUnfinished();
    let told = 0;
    const unsubscribe = subscribeToStartedFiles(() => {
      told += 1;
    });
    const uploader = {};
    dismissReturnNotice(["media-1"], storage);
    setSendingHere(uploader, ["media-2"], storage);
    // The same again changes nothing, and says nothing.
    setSendingHere(uploader, ["media-2"], storage);
    setSendingHere(uploader, [], storage);
    unsubscribe();
    expect(told).toBe(3);
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
