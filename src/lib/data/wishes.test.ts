import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { dbConfig } from "@/lib/env";
import { publicUrl } from "@/lib/storage/keys";
import { resetDb } from "../../../test/db";
import { createGuest } from "./guests";
import type { Wish } from "./types";
import { addWish, findOwnWishMedia, listWishes, recordingsQuery, wallQuery, type LinkOptions } from "./wishes";

/**
 * What addWish is given to send a linked recording's job (Ruling CE): after() as the action passes
 * it, run at once here, and a job queue that records every job it is sent.
 */
const sentJobs: { queue: string; data: unknown }[] = [];
const recordingQueue = {
  send: async (queue: string, data?: object | null) => {
    sentJobs.push({ queue, data });
    return "job";
  },
} as Pick<PgBoss, "send">;
const linking: LinkOptions = {
  defer: (task) => {
    void task();
  },
  jobQueue: async () => recordingQueue,
};

beforeEach(async () => {
  await resetDb();
  sentJobs.length = 0;
});

/** Moves a wish's sending time back, as if it had been sent that many minutes ago. */
async function sentMinutesAgo(id: string, minutes: number): Promise<void> {
  await getDb().execute(sql`update wishes set created_at = now() - make_interval(mins => ${minutes}) where id = ${id}`);
}

describe("addWish", () => {
  it("keeps a written wish in Postgres, with its words, signature and time", async () => {
    const sent = await addWish({ kind: "text", message: "Long life and happiness.", signedAs: "Ama" });

    const [row] = await getDb().select().from(wishes).where(eq(wishes.id, sent.id));
    expect(row).toMatchObject({ kind: "text", message: "Long life and happiness.", signedAs: "Ama" });
    expect(row.hiddenAt).toBeNull();
    expect(row.deletedAt).toBeNull();
    expect(sent).toEqual({
      id: row.id,
      kind: "text",
      message: "Long life and happiness.",
      signedAs: "Ama",
      createdAt: row.createdAt.toISOString(),
    });
  });

  it("refuses a written wish without words", async () => {
    await expect(addWish({ kind: "text", signedAs: "Ama" })).rejects.toThrow();
  });

  it("refuses a voice or video wish without its recording", async () => {
    await expect(addWish({ kind: "voice", signedAs: "Ama", mediaId: "", guestIds: [] }, linking)).rejects.toThrow();
    await expect(addWish({ kind: "video", signedAs: "Ama", mediaId: "", guestIds: [] }, linking)).rejects.toThrow();
  });

  it("keeps the sending browser's own guest with a written wish", async () => {
    const guestId = await newGuest();
    const sent = await addWish({ kind: "text", message: "Hello", signedAs: "Ama", guestId });
    const [row] = await getDb().select().from(wishes).where(eq(wishes.id, sent.id));
    expect(row.guestId).toBe(guestId);
  });
});

async function newGuest(): Promise<string> {
  return (await createGuest("Ama Owusu")).id;
}

/**
 * A recording as the upload API and media.wish leave it: a voice note (audio) or a video message
 * (video) of purpose `wish`, uploaded by `guestId`; ready (its files named), processing, failed or
 * still uploading.
 */
async function recording(
  guestId: string | null,
  kind: "audio" | "video",
  status: "uploading" | "uploaded" | "ready" | "failed" = "ready",
  values: Partial<typeof media.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const derived: Record<string, string> =
    status !== "ready"
      ? {}
      : kind === "audio"
        ? { audio: `derived/${id}/0123456789abcdef/audio.m4a` }
        : {
            video: `derived/${id}/0123456789abcdef/video.mp4`,
            "poster-thumb": `derived/${id}/0123456789abcdef/poster-thumb.webp`,
            "poster-view": `derived/${id}/0123456789abcdef/poster-view.webp`,
          };
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "wish",
      kind,
      guestId,
      uploaderName: "Ama Owusu",
      celebration: "reception",
      originalKey: `originals/${id}.webm`,
      originalFilename: "wish.webm",
      sizeBytes: 1024,
      contentType: kind === "audio" ? "audio/webm" : "video/webm",
      status,
      uploadedAt: status === "uploading" ? null : new Date(),
      derived,
      durationSeconds: status === "ready" ? 24.4 : null,
      width: status === "ready" && kind === "video" ? 720 : null,
      averageColor: status === "ready" && kind === "video" ? "#a08070" : null,
      height: status === "ready" && kind === "video" ? 1280 : null,
      failureReason: status === "failed" ? "corrupt" : null,
      ...values,
    });
  return id;
}

/** A recorded wish, linked as addWish links it; throws if it refuses. */
async function recordedWish(guestId: string, kind: "voice" | "video", mediaId: string, signedAs = "Ama"): Promise<Wish> {
  const wish = await addWish({ kind, mediaId, signedAs, guestIds: [guestId] }, linking);
  if (!wish) throw new Error("addWish refused the recording");
  return wish;
}

describe("addWish for a voice or video wish: it links only the sender's own finished recording, of its kind, once", () => {
  it("links a voice note to a voice wish, and a video message to a video wish, with the recording's guest", async () => {
    const guestId = await newGuest();
    const voice = await recording(guestId, "audio", "uploaded");
    const video = await recording(guestId, "video", "ready");

    const voiceWish = await addWish({ kind: "voice", mediaId: voice, signedAs: "Ama", guestIds: [guestId] }, linking);
    const videoWish = await addWish({ kind: "video", mediaId: video.toUpperCase(), signedAs: "Kofi", guestIds: [guestId] }, linking);

    expect(voiceWish).toMatchObject({ kind: "voice", signedAs: "Ama", pending: { mediaId: voice, state: "processing" } });
    expect(videoWish).toMatchObject({ kind: "video", signedAs: "Kofi", duration: "0:24" });
    const rows = await getDb().select().from(wishes);
    expect(rows.map((row) => [row.mediaId, row.guestId, row.message]).sort()).toEqual(
      [
        [voice, guestId, null],
        [video, guestId, null],
      ].sort(),
    );
  });

  it("links a recording whose processing has failed (its sender is shown why), and one of a guest the browser remembers", async () => {
    const own = await newGuest();
    const remembered = await newGuest();
    const failed = await recording(own, "audio", "failed");
    const theirs = await recording(remembered, "video", "uploaded");

    expect(await addWish({ kind: "voice", mediaId: failed, signedAs: "Ama", guestIds: [own, remembered] }, linking)).toMatchObject({
      pending: { state: "failed" },
    });
    expect(await addWish({ kind: "video", mediaId: theirs, signedAs: "Ama", guestIds: [own, remembered] }, linking)).not.toBeNull();
  });

  it("refuses another guest's recording, an album item, the wrong kind, an unfinished upload, a hidden, removed or deleted one, and nonsense", async () => {
    const guestId = await newGuest();
    const other = await newGuest();
    const cases: [string, string, "voice" | "video"][] = [
      ["another guest's", await recording(other, "audio"), "voice"],
      ["no guest's", await recording(null, "audio"), "voice"],
      ["an album item", await recording(guestId, "audio", "ready", { purpose: "album" }), "voice"],
      ["a video as a voice wish", await recording(guestId, "video"), "voice"],
      ["audio as a video wish", await recording(guestId, "audio"), "video"],
      ["still uploading", await recording(guestId, "audio", "uploading"), "voice"],
      ["hidden", await recording(guestId, "audio", "ready", { hiddenAt: new Date(), hiddenBy: "couple@example.com" }), "voice"],
      [
        "removed by its guest",
        await recording(guestId, "audio", "ready", { hiddenAt: new Date(), hiddenBy: "guest", removedByUploader: true }),
        "voice",
      ],
      ["deleted", await recording(guestId, "audio", "ready", { deletedAt: new Date() }), "voice"],
      ["unknown", randomUUID(), "voice"],
      ["not an id", "not-a-uuid", "voice"],
    ];
    for (const [what, mediaId, kind] of cases) {
      expect(await addWish({ kind, mediaId, signedAs: "Ama", guestIds: [guestId] }, linking), what).toBeNull();
    }
    // A browser with no guest has no recordings.
    expect(await addWish({ kind: "voice", mediaId: await recording(guestId, "audio"), signedAs: "Ama", guestIds: [] }, linking)).toBeNull();
    expect(await getDb().select().from(wishes)).toEqual([]);
  });

  it("links a recording once: the same send again answers the same wish; another wish, or another browser, is refused", async () => {
    const guestId = await newGuest();
    const other = await newGuest();
    const mediaId = await recording(guestId, "audio");

    const first = await recordedWish(guestId, "voice", mediaId);
    const [again, together] = await Promise.all([
      addWish({ kind: "voice", mediaId, signedAs: "Ama again", guestIds: [guestId] }, linking),
      addWish({ kind: "voice", mediaId, signedAs: "Ama again", guestIds: [guestId] }, linking),
    ]);

    expect(again?.id).toBe(first.id);
    expect(together?.id).toBe(first.id);
    expect(await addWish({ kind: "voice", mediaId, signedAs: "Ama", guestIds: [other] }, linking)).toBeNull();
    expect(await getDb().select({ id: wishes.id }).from(wishes)).toHaveLength(1);
  });

  it("makes one wish of two sends at once", async () => {
    const guestId = await newGuest();
    const mediaId = await recording(guestId, "video", "uploaded");
    const sends = await Promise.all(
      Array.from({ length: 5 }, () => addWish({ kind: "video", mediaId, signedAs: "Ama", guestIds: [guestId] }, linking)),
    );
    expect(new Set(sends.map((wish) => wish?.id)).size).toBe(1);
    expect(await getDb().select({ id: wishes.id }).from(wishes)).toHaveLength(1);
  });
});

describe("addWish has a recording made only once it links it (Ruling CE)", () => {
  it("sends one media.wish job, after the response, for a new link; a duplicate send, and a refusal, send none", async () => {
    const guestId = await newGuest();
    const mediaId = await recording(guestId, "audio", "uploaded");
    const deferred: (() => Promise<void>)[] = [];
    const later: LinkOptions = { ...linking, defer: (task) => void deferred.push(task) };

    const wish = await addWish({ kind: "voice", mediaId, signedAs: "Ama", guestIds: [guestId] }, later);
    expect(wish).not.toBeNull();
    // Nothing is sent in the request: only once after() runs.
    expect(sentJobs).toEqual([]);
    await Promise.all(deferred.splice(0).map((task) => task()));
    expect(sentJobs).toEqual([{ queue: "media.wish", data: { mediaId } }]);

    expect((await addWish({ kind: "voice", mediaId, signedAs: "Ama", guestIds: [guestId] }, later))?.id).toBe(wish?.id);
    expect(await addWish({ kind: "voice", mediaId, signedAs: "Ama", guestIds: [await newGuest()] }, later)).toBeNull();
    await Promise.all(deferred.splice(0).map((task) => task()));
    expect(sentJobs).toHaveLength(1);
  });

  it("sends one job however many sends race, and none for a recording it refuses", async () => {
    const guestId = await newGuest();
    const mediaId = await recording(guestId, "video", "uploaded");
    await Promise.all(Array.from({ length: 5 }, () => addWish({ kind: "video", mediaId, signedAs: "Ama", guestIds: [guestId] }, linking)));
    await addWish({ kind: "voice", mediaId: await recording(await newGuest(), "audio", "uploaded"), signedAs: "Ama", guestIds: [guestId] }, linking);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sentJobs).toEqual([{ queue: "media.wish", data: { mediaId } }]);
  });

  it("never fails the send when the queue is down: the sweeper queues a linked recording", async () => {
    const guestId = await newGuest();
    const mediaId = await recording(guestId, "audio", "uploaded");
    const errors: unknown[] = [];
    const down: LinkOptions = {
      defer: (task) => void task().catch((error: unknown) => errors.push(error)),
      jobQueue: async () => {
        throw new Error("queue is down");
      },
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await addWish({ kind: "voice", mediaId, signedAs: "Ama", guestIds: [guestId] }, down)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toEqual([]);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("listWishes for recorded wishes (Ruling BR)", () => {
  it("shows a ready recording to everyone, with the files the worker made and its length", async () => {
    const guestId = await newGuest();
    const voice = await recording(guestId, "audio");
    const video = await recording(guestId, "video");
    const voiceWish = await recordedWish(guestId, "voice", voice);
    const videoWish = await recordedWish(guestId, "video", video);

    const shown = await listWishes();

    expect(shown.find((wish) => wish.id === voiceWish.id)).toEqual({
      id: voiceWish.id,
      kind: "voice",
      signedAs: "Ama",
      createdAt: voiceWish.createdAt,
      duration: "0:24",
      recording: { url: publicUrl(`derived/${voice}/0123456789abcdef/audio.m4a`), thumb: null, color: null, width: null, height: null },
    });
    expect(shown.find((wish) => wish.id === videoWish.id)?.recording).toEqual({
      url: publicUrl(`derived/${video}/0123456789abcdef/video.mp4`),
      // The 480 px thumbnail, never the 1600 px viewing size: the wall loads it lazily (fix round 1).
      thumb: publicUrl(`derived/${video}/0123456789abcdef/poster-thumb.webp`),
      color: "#a08070",
      width: 720,
      height: 1280,
    });
  });

  it("shows a recording still being made ready, or failed, to its sender only: 'Getting your wish ready…' is never anyone else's", async () => {
    const sender = await newGuest();
    const someoneElse = await newGuest();
    const processing = await recordedWish(sender, "voice", await recording(sender, "audio", "uploaded"));
    const failed = await recordedWish(sender, "video", await recording(sender, "video", "failed"));
    const written = await addWish({ kind: "text", message: "Words", signedAs: "Esi" });

    const forSender = await listWishes([sender]);
    expect(forSender.map((wish) => [wish.id, wish.pending?.state ?? null])).toEqual([
      [written.id, null],
      [failed.id, "failed"],
      [processing.id, "processing"],
    ]);
    expect(forSender.find((wish) => wish.id === failed.id)?.recording).toBeUndefined();
    // A remembered guest's sends are the browser's too.
    expect((await listWishes([someoneElse, sender])).map((wish) => wish.id)).toHaveLength(3);
    for (const viewer of [[], [someoneElse]]) {
      expect((await listWishes(viewer)).map((wish) => wish.id), String(viewer)).toEqual([written.id]);
    }
  });

  it("never shows a hidden or deleted wish, or one whose recording is hidden or deleted, even to its sender", async () => {
    const sender = await newGuest();
    const hiddenWish = await recordedWish(sender, "voice", await recording(sender, "audio"));
    await getDb().update(wishes).set({ hiddenAt: new Date(), hiddenBy: "couple@example.com" }).where(eq(wishes.id, hiddenWish.id));
    const hiddenRecording = await recording(sender, "video");
    await recordedWish(sender, "video", hiddenRecording);
    await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "couple@example.com" }).where(eq(media.id, hiddenRecording));
    const deletedRecording = await recording(sender, "audio", "uploaded");
    await recordedWish(sender, "voice", deletedRecording);
    await getDb().update(media).set({ deletedAt: new Date() }).where(eq(media.id, deletedRecording));

    expect(await listWishes([sender])).toEqual([]);
    expect(await listWishes()).toEqual([]);
  });

  it("shows a ready recording whose file isn't there as being made ready, to its sender only", async () => {
    const sender = await newGuest();
    const mediaId = await recording(sender, "audio", "ready", { derived: {} });
    const wish = await recordedWish(sender, "voice", mediaId);

    expect(await listWishes()).toEqual([]);
    expect((await listWishes([sender]))[0]).toMatchObject({ id: wish.id, pending: { mediaId, state: "processing" } });
  });

  it("is never an orphan recording: an upload whose wish never came is on no wall", async () => {
    const sender = await newGuest();
    await recording(sender, "audio", "ready");
    await recording(sender, "video", "uploaded");
    expect(await listWishes([sender])).toEqual([]);
  });

  it("reads the recordings by their primary key, never a scan of media, on a wedding's worth of rows", async () => {
    const client = postgres({ ...dbConfig(), max: 1, onnotice: () => {} });
    try {
      // The album's 6,000 items from 300 guests, as the album's own plan tests have it (listed, most of
      // them ready), a few hundred wishes beside them, a third of them recorded, analysed: statistics
      // like the night's, which the other plan tests that run after this one see too.
      await client`insert into guests (id, link_token)
        select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'wall-token-' || n from generate_series(1, 300) as n`;
      await client`insert into media (purpose, kind, guest_id, uploader_name, celebration, original_key, original_filename,
          size_bytes, content_type, status, listed_at, derived)
        select case when n % 15 = 0 then 'wish' else 'album' end, case when n % 15 = 0 then 'audio' else 'photo' end,
          ('00000000-0000-4000-8000-' || lpad((n % 300 + 1)::text, 12, '0'))::uuid, 'Guest', 'reception',
          'originals/wall-' || n || '.jpg', 'IMG.JPG', 3000000, 'image/jpeg',
          case when n % 97 = 0 then 'uploaded' else 'ready' end,
          case when n % 97 = 0 then null else now() - make_interval(secs => 6000 - n) end, '{}'::jsonb
        from generate_series(1, 6000) as n`;
      await client`insert into wishes (kind, signed_as, guest_id, media_id, message)
        select 'voice', 'Guest', guest_id, id, null from media where purpose = 'wish'`;
      await client`insert into wishes (kind, signed_as, message) select 'text', 'Guest', 'Words ' || n from generate_series(1, 400) as n`;
      await client`vacuum analyze media`;
      await client`vacuum analyze wishes`;
      const planOf = async (query: { toSQL(): { sql: string } }) => {
        const rows = await client.unsafe(`explain (generic_plan) ${query.toSQL().sql}`).simple();
        return rows.map((row) => String(row["QUERY PLAN"])).join("\n");
      };
      expect(await planOf(wallQuery())).not.toContain("media");
      const recorded = await client`select media_id from wishes where media_id is not null`;
      const plan = await planOf(recordingsQuery(recorded.map((row) => String(row.media_id))));
      expect(plan).not.toContain("Seq Scan");
      expect(plan).toMatch(/media_pkey/);
    } finally {
      await client.end();
    }
  });
});

describe("findOwnWishMedia: the sender's 'getting ready' check (Ruling BU)", () => {
  it("answers the browser's own linked recordings, each with how far it has got", async () => {
    const sender = await newGuest();
    const processing = await recording(sender, "audio", "uploaded");
    const ready = await recording(sender, "video", "ready");
    const failed = await recording(sender, "audio", "failed");
    for (const [mediaId, kind] of [
      [processing, "voice"],
      [ready, "video"],
      [failed, "voice"],
    ] as const) {
      await recordedWish(sender, kind, mediaId);
    }

    const answer = await findOwnWishMedia([processing, ready.toUpperCase(), failed, "nonsense"], [sender]);

    expect(answer.sort((first, second) => first.id.localeCompare(second.id))).toEqual(
      [
        { id: processing, state: "processing" },
        { id: ready, state: "ready" },
        { id: failed, state: "failed" },
      ].sort((first, second) => first.id.localeCompare(second.id)),
    );
  });

  it("leaves out, as if missing: another guest's, an orphan, a hidden or deleted wish or recording, and an album item", async () => {
    const sender = await newGuest();
    const other = await newGuest();
    const theirs = await recording(other, "audio", "uploaded");
    await recordedWish(other, "voice", theirs);
    const orphan = await recording(sender, "audio", "uploaded");
    const hiddenWish = await recording(sender, "audio", "uploaded");
    const wish = await recordedWish(sender, "voice", hiddenWish);
    await getDb().update(wishes).set({ hiddenAt: new Date(), hiddenBy: "couple@example.com" }).where(eq(wishes.id, wish.id));
    const hiddenRecording = await recording(sender, "video", "uploaded");
    await recordedWish(sender, "video", hiddenRecording);
    await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "couple@example.com" }).where(eq(media.id, hiddenRecording));
    const album = await recording(sender, "video", "ready", { purpose: "album" });

    expect(await findOwnWishMedia([theirs, orphan, hiddenWish, hiddenRecording, album], [sender])).toEqual([]);
    expect(await findOwnWishMedia([theirs], [])).toEqual([]);
  });
});

describe("listWishes", () => {
  it("lists the wishes newest first", async () => {
    const first = await addWish({ kind: "text", message: "First", signedAs: "Kofi" });
    const second = await addWish({ kind: "text", message: "Second", signedAs: "Esi" });
    const third = await addWish({ kind: "text", message: "Third", signedAs: "Yaw" });
    await sentMinutesAgo(first.id, 30);
    await sentMinutesAgo(second.id, 10);

    const listed = await listWishes();
    expect(listed.map((wish) => wish.message)).toEqual(["Third", "Second", "First"]);
    expect(listed[0]).toEqual(third);
  });

  it("leaves out a hidden wish and a deleted one", async () => {
    const kept = await addWish({ kind: "text", message: "Kept", signedAs: "Kofi" });
    const hidden = await addWish({ kind: "text", message: "Hidden", signedAs: "Esi" });
    const deleted = await addWish({ kind: "text", message: "Deleted", signedAs: "Yaw" });
    await getDb()
      .update(wishes)
      .set({ hiddenAt: new Date(), hiddenBy: "admin@example.com" })
      .where(eq(wishes.id, hidden.id));
    await getDb().update(wishes).set({ deletedAt: new Date() }).where(eq(wishes.id, deleted.id));

    expect((await listWishes()).map((wish) => wish.id)).toEqual([kept.id]);
  });

  it("is empty when no one has written yet", async () => {
    expect(await listWishes()).toEqual([]);
  });
});
