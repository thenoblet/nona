import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dbConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { resetDb } from "../../../test/db";
import { addSitePhoto } from "../../../test/site-images";
import { redrawRsvpCard, sendCardJobOrLog } from "./cards";
import { readAllSiteImages, readLiveSiteImage, saveSiteImage, slotLockName } from "./store";

// Against the test database (docker compose up -d db). The job queue is a stand-in that records sends.

const sent: { name: string; data: unknown }[] = [];
const queue = async () =>
  ({
    send: async (name: string, data?: object | null) => {
      sent.push({ name, data });
      return randomUUID();
    },
  }) as Pick<PgBoss, "send">;
const brokenQueue = async () =>
  ({
    send: async () => {
      throw new Error("the queue is down");
    },
  }) as unknown as Pick<PgBoss, "send">;

// A connection of the test's own, to hold a slot's lock from outside and watch who waits for it.
const outside = postgres({ ...dbConfig(), max: 1, connect_timeout: 5, onnotice: () => {} });

afterAll(async () => {
  await outside.end();
});

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

/** How many sessions are waiting for an advisory lock. */
async function waitingForLocks(): Promise<number> {
  const [row] = await outside`select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`;
  return row.waiting;
}

async function untilWaiting(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await waitingForLocks()) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Never saw ${count} session(s) waiting for the slot's lock`);
}

/** Holds the RSVP slot's lock from outside while `queue` lines writers up behind it, then lets them go in order. */
async function inOrderBehindTheLock(queue: (() => Promise<unknown>)[]): Promise<void> {
  await outside`select pg_advisory_lock(hashtextextended(${slotLockName("preview-rsvp")}, 0))`;
  const running: Promise<unknown>[] = [];
  try {
    for (const [index, start] of queue.entries()) {
      running.push(start());
      await untilWaiting(index + 1);
    }
  } finally {
    await outside`select pg_advisory_unlock(hashtextextended(${slotLockName("preview-rsvp")}, 0))`;
  }
  await Promise.all(running);
}

describe("redrawRsvpCard", () => {
  it("gives a slot still on its built-in photo a row of its own, the built-in's, and sends its card to the worker", async () => {
    await redrawRsvpCard("couple@example.com", queue);
    const live = await readLiveSiteImage("preview-rsvp");
    expect(live).toMatchObject({
      mediaId: null,
      alt: "Nancy holds her bouquet and the ring as they hug",
      focal: { x: 0.5, y: 0.2 },
      savedBy: "couple@example.com",
      cardKey: null,
    });
    expect(sent).toEqual([{ name: MEDIA_QUEUES.card, data: { siteImageId: live?.id } }]);
  });

  it("draws the live row again, adding none, when the couple changed the photo or the slot has its row already", async () => {
    const mediaId = await addSitePhoto();
    const saved = await saveSiteImage({ slot: "preview-rsvp", mediaId, alt: "Us", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    await redrawRsvpCard("couple@example.com", queue);
    await redrawRsvpCard("couple@example.com", queue);
    expect((await readAllSiteImages()).map((row) => row.id)).toEqual([saved.id]);
    expect(sent).toEqual([
      { name: MEDIA_QUEUES.card, data: { siteImageId: saved.id } },
      { name: MEDIA_QUEUES.card, data: { siteImageId: saved.id } },
    ]);
  });

  it("adds one built-in row for two redraws at once, and sends both jobs for it", async () => {
    await Promise.all([redrawRsvpCard("noblet@example.com", queue), redrawRsvpCard("nancy@example.com", queue)]);
    const rows = await readAllSiteImages();
    expect(rows).toHaveLength(1);
    expect(sent).toEqual([
      { name: MEDIA_QUEUES.card, data: { siteImageId: rows[0].id } },
      { name: MEDIA_QUEUES.card, data: { siteImageId: rows[0].id } },
    ]);
  });

  it("never lets its built-in row overtake the couple's photo saved at the same moment, in either order", async () => {
    const mediaId = await addSitePhoto();
    const savePhoto = () => saveSiteImage({ slot: "preview-rsvp", mediaId, alt: "Our photo", focal: { x: 0.5, y: 0.5 }, savedBy: "nancy@example.com" });
    const redraw = () => redrawRsvpCard("noblet@example.com", queue);

    // The photo's save first: the redraw finds it and adds nothing.
    await inOrderBehindTheLock([savePhoto, redraw]);
    expect((await readLiveSiteImage("preview-rsvp"))?.mediaId).toBe(mediaId);
    expect(await readAllSiteImages()).toHaveLength(1);

    // The redraw first: its built-in row, then the photo's, which is newer and so live.
    await resetDb();
    const secondPhoto = await addSitePhoto();
    await inOrderBehindTheLock([
      redraw,
      () => saveSiteImage({ slot: "preview-rsvp", mediaId: secondPhoto, alt: "Our photo", focal: { x: 0.5, y: 0.5 }, savedBy: "nancy@example.com" }),
    ]);
    expect((await readLiveSiteImage("preview-rsvp"))?.mediaId).toBe(secondPhoto);
    expect((await readAllSiteImages()).map((row) => row.mediaId)).toEqual([secondPhoto, null]);
  });

  it("leaves the couple's photo live however a save and a redraw race, over many rounds", async () => {
    for (let round = 0; round < 25; round += 1) {
      await resetDb();
      const mediaId = await addSitePhoto();
      await Promise.all([
        redrawRsvpCard("noblet@example.com", queue),
        saveSiteImage({ slot: "preview-rsvp", mediaId, alt: "Our photo", focal: { x: 0.5, y: 0.5 }, savedBy: "nancy@example.com" }),
      ]);
      expect((await readLiveSiteImage("preview-rsvp"))?.mediaId, `round ${round}`).toBe(mediaId);
    }
  });

  it("logs rather than throws when the queue is down", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(redrawRsvpCard("couple@example.com", brokenQueue)).resolves.toBeUndefined();
    await expect(sendCardJobOrLog(randomUUID(), brokenQueue)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
