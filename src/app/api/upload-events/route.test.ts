import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGuest } from "@/lib/data/guests";
import { getDb } from "@/lib/db/client";
import { media, uploadEvents } from "@/lib/db/schema";
import { originalKey } from "@/lib/storage/keys";
import { resetDb } from "../../../../test/db";
import { asBrowser, browserCookies, newCookieJar } from "../../../../test/next-cookies";
import { jsonRequest } from "../../../../test/uploads";

vi.mock("next/headers", () => import("../../../../test/next-cookies"));

import { guestCookieName, signGuestIds } from "@/lib/guests/cookie";
import { POST } from "./route";

const post = (body: unknown) => POST(jsonRequest("/api/upload-events", "POST", body));

/** A guest for this browser (the default cookie jar). */
async function signIn(displayName = "Ama Owusu") {
  const guest = await createGuest(displayName);
  browserCookies.values.set(guestCookieName(), signGuestIds([guest.id]));
  return guest;
}

/** An unfinished upload of this guest's, written straight to the table. */
async function addUpload(guestId: string): Promise<string> {
  const id = randomUUID();
  await getDb().insert(media).values({
    id,
    purpose: "album",
    kind: "photo",
    guestId,
    celebration: "more",
    originalKey: originalKey(id, "jpg"),
    originalFilename: "IMG_0001.JPG",
    sizeBytes: 9_000_000,
    contentType: "image/jpeg",
  });
  return id;
}

async function storedEvents() {
  return getDb()
    .select({
      guestId: uploadEvents.guestId,
      mediaId: uploadEvents.mediaId,
      kind: uploadEvents.kind,
      reason: uploadEvents.reason,
      detail: uploadEvents.detail,
    })
    .from(uploadEvents)
    .orderBy(uploadEvents.createdAt);
}

beforeEach(async () => {
  await resetDb();
  browserCookies.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/upload-events", () => {
  it("stores a guest's part retries and failures, keeping only the detail fields it knows", async () => {
    const guest = await signIn();
    const mediaId = await addUpload(guest.id);
    const response = await post({
      events: [
        {
          kind: "part-retry",
          mediaId,
          reason: "network-error",
          detail: { partNumber: 3, attempt: 2, httpStatus: 0, online: true, elapsedMs: 1200, errorName: "TypeError" },
        },
        // The filename and URL are dropped: the status page needs neither, and both can be personal.
        { kind: "failed", reason: "http-403", detail: { filename: "IMG_0001.JPG", url: "https://x?X-Amz-Signature=1" } },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ stored: 2 });
    expect(await storedEvents()).toEqual([
      {
        guestId: guest.id,
        mediaId,
        kind: "part-retry",
        reason: "network-error",
        detail: { partNumber: 3, attempt: 2, httpStatus: 0, online: true, elapsedMs: 1200, errorName: "TypeError" },
      },
      { guestId: guest.id, mediaId: null, kind: "failed", reason: "http-403", detail: {} },
    ]);
  });

  it("refuses an event about another guest's upload, or one it can't find, with 403, storing nothing", async () => {
    await signIn();
    const stranger = await createGuest("Kofi");
    const theirs = await addUpload(stranger.id);
    for (const mediaId of [theirs, randomUUID()]) {
      const response = await post({ events: [{ kind: "failed", mediaId, reason: "timeout" }] });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect(await storedEvents()).toEqual([]);
  });

  it("accepts events about an upload of a guest the browser remembers through a personal link", async () => {
    const owner = await createGuest("Ama");
    const mediaId = await addUpload(owner.id);
    const secondPhone = newCookieJar();
    const own = await createGuest(null);
    secondPhone.values.set(guestCookieName(), signGuestIds([own.id, owner.id]));
    const response = await asBrowser(secondPhone, () => post({ events: [{ kind: "part-retry", mediaId }] }));
    expect(response.status).toBe(200);
    expect(await storedEvents()).toEqual([
      { guestId: own.id, mediaId, kind: "part-retry", reason: null, detail: null },
    ]);
  });

  it("refuses a browser without a guest, anything but JSON, an oversized body and events it doesn't take", async () => {
    expect((await post({ events: [{ kind: "failed" }] })).status).toBe(403);

    await signIn();
    const text = await POST(
      new Request("https://example.com/api/upload-events", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
    );
    expect(text.status).toBe(415);
    expect((await post({ events: [{ kind: "failed", reason: "a".repeat(20_000) }] })).status).toBe(413);
    for (const body of [
      {},
      { events: [] },
      { events: Array.from({ length: 21 }, () => ({ kind: "failed" })) },
      // The server records these itself.
      { events: [{ kind: "completed" }] },
      { events: [{ kind: "resumed" }] },
      { events: [{ kind: "failed", mediaId: "not-a-uuid" }] },
      // A reason is a short code, never free text that could carry a URL or a name.
      { events: [{ kind: "failed", reason: "Failed to fetch https://x?X-Amz-Signature=1" }] },
      { events: [{ kind: "failed", detail: { partNumber: -1 } }] },
    ]) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((await response.json()).error).toBe("bad-request");
    }
    expect(await storedEvents()).toEqual([]);
  });

  it("limits a guest to a burst of 100 reports, then answers 429 with Retry-After", async () => {
    vi.spyOn(performance, "now").mockReturnValue(9_000);
    await signIn();
    for (let request = 0; request < 100; request += 1) expect((await post({})).status).toBe(400);
    const limited = await post({ events: [{ kind: "failed" }] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("1");
  });

  it("keeps an event when its upload is cancelled, without the upload", async () => {
    const guest = await signIn();
    const mediaId = await addUpload(guest.id);
    await post({ events: [{ kind: "failed", mediaId, reason: "timeout" }] });
    await getDb().delete(media).where(eq(media.id, mediaId));
    expect(await storedEvents()).toMatchObject([{ kind: "failed", mediaId: null, guestId: guest.id }]);
  });
});
