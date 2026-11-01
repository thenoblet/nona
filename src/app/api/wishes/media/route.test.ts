import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { addWish } from "@/lib/data/wishes";
import { getDb } from "@/lib/db/client";
import { media } from "@/lib/db/schema";
import { RATE_LIMITS, takeToken } from "@/lib/guests/rate-limit";
import { addAlbumItem } from "../../../../../test/album";
import { resetDb } from "../../../../../test/db";
import { browserCookies } from "../../../../../test/next-cookies";

// Against the test database (docker compose up -d db).

vi.mock("next/headers", () => import("../../../../../test/next-cookies"));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { GET } from "./route";

function asGuests(...guestIds: string[]): void {
  browserCookies.values.set(guestCookieName(), signGuestIds(guestIds));
}

function wishMediaRequest(ids: string[]): Request {
  return new Request(`https://example.com/api/wishes/media?ids=${ids.join(",")}`);
}

/** A voice note's recording, as the upload API and media.wish leave it, and the wish that names it. */
async function sentRecording(guestId: string, status: "uploaded" | "ready" | "failed" = "uploaded", link = true): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(media)
    .values({
      id,
      purpose: "wish",
      kind: "audio",
      guestId,
      celebration: "reception",
      originalKey: `originals/${id}.webm`,
      originalFilename: "voice.webm",
      sizeBytes: 2048,
      contentType: "audio/webm",
      status,
      uploadedAt: new Date(),
      derived: status === "ready" ? { audio: `derived/${id}/0123456789abcdef/audio.m4a` } : {},
    });
  if (link && !(await addWish({ kind: "voice", mediaId: id, signedAs: "Ama", guestIds: [guestId] }))) {
    throw new Error("addWish refused the recording");
  }
  return id;
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

describe("GET /api/wishes/media?ids= (Ruling BU)", () => {
  it("answers the sender's own recordings, each with how far it has got, in one request", async () => {
    const sender = await createGuest("Ama Owusu");
    asGuests(sender.id);
    const processing = await sentRecording(sender.id);
    const ready = await sentRecording(sender.id, "ready");
    const failed = await sentRecording(sender.id, "failed");

    const response = await GET(wishMediaRequest([processing, ready, failed]));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const { items } = (await response.json()) as { items: { id: string; state: string }[] };
    expect(Object.fromEntries(items.map((item) => [item.id, item.state]))).toEqual({
      [processing]: "processing",
      [ready]: "ready",
      [failed]: "failed",
    });
  });

  it("answers nothing of another guest's, an orphan, a hidden one or an album item: each the same as one that doesn't exist", async () => {
    const sender = await createGuest("Ama Owusu");
    const stranger = await createGuest("Yaw Boateng");
    const theirs = await sentRecording(stranger.id);
    const theirsReady = await sentRecording(stranger.id, "ready");
    const orphan = await sentRecording(sender.id, "uploaded", false);
    const hidden = await sentRecording(sender.id);
    await getDb().update(media).set({ hiddenAt: new Date(), hiddenBy: "couple@example.com" }).where(eq(media.id, hidden));
    const album = await addAlbumItem({ guestId: sender.id, status: "uploaded" });
    const named = [theirs, theirsReady, orphan, hidden, album, randomUUID(), "not-an-id"];

    asGuests(sender.id);
    const answer = await GET(wishMediaRequest(named));
    browserCookies.clear();
    const noGuest = await GET(wishMediaRequest(named));

    expect(await answer.json()).toEqual({ items: [] });
    expect(noGuest.status).toBe(200);
    expect(await noGuest.json()).toEqual({ items: [] });
  });

  it("takes one request from the guest's own bucket however many it names, and refuses past it with Retry-After", async () => {
    const sender = await createGuest("Ama Owusu");
    asGuests(sender.id);
    const ids = await Promise.all(Array.from({ length: 50 }, () => sentRecording(sender.id)));
    for (let request = 0; request < RATE_LIMITS.item.burst - 1; request += 1) takeToken(sender.id, "item");

    expect((await GET(wishMediaRequest(ids))).status).toBe(200);
    const refused = await GET(wishMediaRequest(ids));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("refuses none or more than 50 at once", async () => {
    expect((await GET(new Request("https://example.com/api/wishes/media"))).status).toBe(400);
    expect((await GET(wishMediaRequest(Array.from({ length: 51 }, () => randomUUID())))).status).toBe(400);
  });
});
