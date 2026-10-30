import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { EVENT_IDS } from "@/lib/content/schema";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../../test/db";
import { getDb } from "./client";
import { guests, media, wishes } from "./schema";

beforeEach(resetDb);

async function addGuest(displayName: string | null = "Ama"): Promise<string> {
  const [row] = await getDb()
    .insert(guests)
    .values({ displayName, linkToken: randomUUID() })
    .returning({ id: guests.id });
  return row.id;
}

/** Inserts a media row (an uploading album photo unless changed) and returns its id. */
async function addMedia(changes: Partial<typeof media.$inferInsert> = {}): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "album",
      kind: "photo",
      uploaderName: "Ama",
      celebration: "reception",
      originalKey: originalKey(id, "jpg"),
      originalFilename: "IMG_0001.jpg",
      sizeBytes: 1_000,
      contentType: "image/jpeg",
      ...changes,
    });
  return id;
}

/** The constraint a failed insert or update broke, from postgres.js's error under drizzle's. */
async function brokenConstraint(write: Promise<unknown>): Promise<string | undefined> {
  const error = await write.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error, "the write should have been refused").toBeDefined();
  return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
}

describe("names and filenames are bounded", () => {
  it("allows a guest name of 80 characters, counting an accented letter or emoji as one", async () => {
    await expect(addGuest("Ɔ".repeat(79) + "😊")).resolves.toBeDefined();
  });

  it("refuses a guest name over 80 characters", async () => {
    expect(await brokenConstraint(addGuest("a".repeat(81)))).toBe("guests_display_name_length");
  });

  it("refuses an uploader name over 80 characters", async () => {
    expect(await brokenConstraint(addMedia({ uploaderName: "a".repeat(81) }))).toBe("media_uploader_name_length");
  });

  it("allows an original filename of 255 characters and refuses a longer one", async () => {
    await expect(addMedia({ originalFilename: `${"a".repeat(251)}.jpg` })).resolves.toBeDefined();
    expect(await brokenConstraint(addMedia({ originalFilename: `${"a".repeat(252)}.jpg` }))).toBe(
      "media_original_filename_length",
    );
  });
});

describe("media", () => {
  it("keeps an item under one of the celebrations or 'more'", async () => {
    for (const celebration of [...EVENT_IDS, "more"] as const) {
      await expect(addMedia({ celebration })).resolves.toBeDefined();
    }
    const unknown = addMedia({ celebration: "afterparty" as (typeof EVENT_IDS)[number] });
    expect(await brokenConstraint(unknown)).toBe("media_celebration_check");
  });

  it("refuses an item removed by its uploader that isn't hidden: removing hides it", async () => {
    expect(await brokenConstraint(addMedia({ removedByUploader: true }))).toBe("media_removed_is_hidden");
    await expect(
      addMedia({ removedByUploader: true, hiddenAt: new Date(), hiddenBy: "guest" }),
    ).resolves.toBeDefined();
  });
});

describe("wishes", () => {
  it("give each recording to one wish only", async () => {
    const recording = await addMedia({ purpose: "wish", kind: "audio", contentType: "audio/webm" });
    const voiceWish = { kind: "voice" as const, signedAs: "Ama", mediaId: recording };
    await getDb().insert(wishes).values(voiceWish);
    expect(await brokenConstraint(getDb().insert(wishes).values(voiceWish))).toBe("wishes_media_id_unique");
  });

  it("still take any number of written wishes, which have no recording", async () => {
    const written = { kind: "text" as const, signedAs: "Ama", message: "Congratulations" };
    await getDb().insert(wishes).values([written, written, written]);
    expect(await getDb().$count(wishes)).toBe(3);
  });
});
