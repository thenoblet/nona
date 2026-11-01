import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { media, wishes } from "@/lib/db/schema";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { resetDb } from "../../../../test/db";
import { browserCookies } from "../../../../test/next-cookies";

// One browser's cookie jar, against the test database (docker compose up -d db).
vi.mock("next/headers", () => import("../../../../test/next-cookies"));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/cache", () => ({ refresh: router.refresh }));

// after() runs its task once the response is sent; the tests run those tasks when they choose.
const afterTasks = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    afterTasks.push(task);
  },
}));

// The job queue, standing in for pg-boss: every job sent, by queue.
const queue = vi.hoisted(() => ({ sent: [] as { name: string; data: unknown }[] }));
vi.mock("@/lib/jobs/boss", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/jobs/boss")>();
  return {
    ...real,
    getBoss: async () => ({
      send: async (name: string, data: unknown) => {
        queue.sent.push({ name, data });
        return "job-1";
      },
    }),
  };
});

/** Runs every task the action handed to after(), as Next does once the response is sent. */
async function afterResponse(): Promise<void> {
  for (const task of afterTasks.splice(0)) await task();
}

import { guestCookieName, readGuestIds, signGuestIds } from "@/lib/guests/cookie";
import { sendRecordedWish, sendWish, type WishFormState } from "./actions";

function asGuests(...guestIds: string[]): void {
  browserCookies.values.set(guestCookieName(), signGuestIds(guestIds));
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}

const idle: WishFormState = { status: "idle" };

/** A finished recording of this guest's, as the upload API leaves it once complete. */
async function uploadedRecording(guestId: string | null, kind: "audio" | "video" = "audio"): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "wish",
      kind,
      guestId,
      celebration: "reception",
      originalKey: `originals/${id}.webm`,
      originalFilename: "wish.webm",
      sizeBytes: 2048,
      contentType: kind === "audio" ? "audio/webm" : "video/webm",
      status: "uploaded",
      uploadedAt: new Date(),
    });
  return id;
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
  router.refresh.mockClear();
  afterTasks.length = 0;
  queue.sent.length = 0;
  (globalThis as { __nonaRateLimits?: Map<string, number> }).__nonaRateLimits?.clear();
});

describe("sendWish: a written wish", () => {
  it("is saved with the browser's own guest, made for it if it had none, and the wall re-renders", async () => {
    const state = await sendWish(idle, form({ kind: "text", message: "Long life!", signedAs: "Ama" }));

    expect(state).toMatchObject({ status: "sent", sent: { signedAs: "Ama" } });
    const [ownId] = await readGuestIds();
    expect(ownId).toBeTruthy();
    const [row] = await getDb().select().from(wishes);
    expect(row).toMatchObject({ kind: "text", message: "Long life!", guestId: ownId });
    expect(router.refresh).toHaveBeenCalledOnce();
  });

  it("is limited by the browser's own guest, never by IP: past the text-wish burst it waits, and another browser doesn't", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    for (let sent = 0; sent < RATE_LIMITS["text-wish"].burst; sent += 1) {
      expect((await sendWish(idle, form({ kind: "text", message: `Wish ${sent}`, signedAs: "Ama" }))).status).toBe("sent");
    }

    const refused = await sendWish(idle, form({ kind: "text", message: "One more", signedAs: "Ama" }));

    expect(refused).toMatchObject({
      status: "error",
      values: { message: "One more", signedAs: "Ama" },
      errors: { form: "You've sent a few wishes just now. Please wait a minute, then send this one." },
    });
    expect(await getDb().select().from(wishes).where(eq(wishes.message, "One more"))).toEqual([]);
    asGuests((await createGuest("Kofi")).id);
    expect((await sendWish(idle, form({ kind: "text", message: "Another browser", signedAs: "Kofi" }))).status).toBe("sent");
  });

  it("checks the words and the signature before anything else, so a mistake costs no turn", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    for (let tried = 0; tried < RATE_LIMITS["text-wish"].burst + 2; tried += 1) {
      expect(await sendWish(idle, form({ kind: "text", message: "", signedAs: "Ama" }))).toMatchObject({ status: "error", errors: { message: expect.any(String) } });
    }
    expect((await sendWish(idle, form({ kind: "text", message: "Now", signedAs: "Ama" }))).status).toBe("sent");
  });
});

describe("sendRecordedWish: a voice or video wish, after its recording has arrived", () => {
  it("links the browser's own recording and re-renders the wall, where its sender sees it being made ready", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    const mediaId = await uploadedRecording(guest.id);

    const state = await sendRecordedWish({ kind: "voice", mediaId, signedAs: "  Ama Owusu " });

    expect(state).toMatchObject({ status: "sent", sent: { signedAs: "Ama Owusu" } });
    const [row] = await getDb().select().from(wishes);
    expect(row).toMatchObject({ kind: "voice", mediaId, guestId: guest.id, signedAs: "Ama Owusu" });
    expect(router.refresh).toHaveBeenCalledOnce();
    // Its recording is made now that a wish names it (Ruling CE), once, after the response.
    expect(queue.sent).toEqual([]);
    await afterResponse();
    expect(queue.sent).toEqual([{ name: "media.wish", data: { mediaId } }]);
  });

  it("has the recording made once even when the phone sends again after a lost answer, and still ends in its processing", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    const mediaId = await uploadedRecording(guest.id, "video");

    const first = await sendRecordedWish({ kind: "video", mediaId, signedAs: "Ama" });
    // The answer is lost on the way back; link-wish.ts asks again.
    const again = await sendRecordedWish({ kind: "video", mediaId, signedAs: "Ama" });
    await afterResponse();

    expect(again).toEqual(first);
    expect(queue.sent).toEqual([{ name: "media.wish", data: { mediaId } }]);
  });

  it("refuses a recording that isn't the browser's, or is of the other kind, without a word about whose it is", async () => {
    const guest = await createGuest("Ama");
    const stranger = await createGuest("Yaw");
    asGuests(guest.id);
    const theirs = await uploadedRecording(stranger.id);
    const video = await uploadedRecording(guest.id, "video");

    for (const input of [
      { kind: "voice" as const, mediaId: theirs, signedAs: "Ama" },
      { kind: "voice" as const, mediaId: video, signedAs: "Ama" },
      { kind: "video" as const, mediaId: randomUUID(), signedAs: "Ama" },
    ]) {
      expect(await sendRecordedWish(input)).toEqual({ status: "refused", message: "We couldn't find your recording. Please record it again." });
    }
    browserCookies.clear();
    expect((await sendRecordedWish({ kind: "voice", mediaId: theirs, signedAs: "Ama" })).status).toBe("refused");
    expect(await getDb().select().from(wishes)).toEqual([]);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("refuses a missing or overlong signature and anything that isn't a recorded wish", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    const mediaId = await uploadedRecording(guest.id);

    expect(await sendRecordedWish({ kind: "voice", mediaId, signedAs: "   " })).toEqual({
      status: "error",
      message: "Please sign your wish with your name.",
    });
    expect(await sendRecordedWish({ kind: "voice", mediaId, signedAs: "A".repeat(81) })).toEqual({
      status: "error",
      message: "Please keep your name under 80 characters.",
    });
    for (const input of [{ kind: "text", mediaId, signedAs: "Ama" }, { kind: "voice", signedAs: "Ama" }, null, "voice"]) {
      expect((await sendRecordedWish(input as never)).status).toBe("error");
    }
    expect(await getDb().select().from(wishes)).toEqual([]);
  });

  it("is limited by the browser's own guest: past the wish burst it says how long to wait, and the phone waits it out", async () => {
    const guest = await createGuest("Ama");
    asGuests(guest.id);
    const mediaId = await uploadedRecording(guest.id);
    // The burst used up at once (each send's own database work would let tokens refill meanwhile).
    for (let sent = 0; sent < RATE_LIMITS.wish.burst; sent += 1) takeToken(guest.id, "wish");

    const state = await sendRecordedWish({ kind: "voice", mediaId, signedAs: "Ama" });

    expect(state).toMatchObject({ status: "rate-limited" });
    expect(state.status === "rate-limited" && state.retryAfterSeconds).toBeGreaterThan(0);
    expect(await getDb().select().from(wishes)).toEqual([]);
  });
});
