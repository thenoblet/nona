import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { addAlbumItem } from "../../../test/album";
import { resetDb } from "../../../test/db";

// Against the test database (docker compose up -d db).

// A read that fails, when a test asks for one.
const failing = vi.hoisted(() => ({ sharers: false, album: false }));
vi.mock("./album", async (importOriginal) => {
  const real = await importOriginal<typeof import("./album")>();
  const refused = () => Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
  return {
    ...real,
    countSharers: () => (failing.sharers ? refused() : real.countSharers()),
    listAlbum: (options: Parameters<typeof real.listAlbum>[0]) => (failing.album ? refused() : real.listAlbum(options)),
  };
});

import { readAlbumOverview } from "./album-overview";

beforeEach(async () => {
  await resetDb();
  failing.sharers = false;
  failing.album = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Two photos and a video from two guests. */
async function threeMoments(): Promise<void> {
  const [ama, kojo] = [await createGuest("Ama"), await createGuest("Kojo")];
  await addAlbumItem({ guestId: ama.id });
  await addAlbumItem({ guestId: ama.id, kind: "video" });
  await addAlbumItem({ guestId: kojo.id });
}

describe("readAlbumOverview", () => {
  it("reads the first page, the counts and the line counting them", async () => {
    await threeMoments();
    const overview = await readAlbumOverview([]);
    expect(overview.album?.items).toHaveLength(3);
    expect(overview.stats).not.toBeNull();
    expect(overview.summary).toBe("2 photos and 1 video from 2 of you, all in one place.");
  });

  it("keeps the album when only the count of who shared fails, and leaves who out of the line", async () => {
    await threeMoments();
    failing.sharers = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const overview = await readAlbumOverview([]);
    expect(overview.album?.items).toHaveLength(3);
    expect(overview.stats).not.toBeNull();
    expect(overview.summary).toBe("2 photos and 1 video, all in one place.");
    expect(errors).toHaveBeenCalledWith("[home] could not count who shared:", "Error (57014)");
  });

  it("says what the album holds, with no counts, when the album itself can't be read", async () => {
    await threeMoments();
    failing.album = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const overview = await readAlbumOverview([]);
    expect(overview.album).toBeNull();
    expect(overview.stats).toBeNull();
    expect(overview.summary).toBe("Every photo and video you share, all in one place.");
    expect(errors).toHaveBeenCalledWith("[home] could not read the album:", "Error (57014)");
  });
});
