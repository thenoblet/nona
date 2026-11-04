import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { resetDb } from "../../../test/db";
import { addSitePhoto } from "../../../test/site-images";
import { redrawRsvpCard, sendCardJobOrLog } from "./cards";
import { readAllSiteImages, readLiveSiteImage, saveSiteImage } from "./store";

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

beforeEach(async () => {
  await resetDb();
  sent.length = 0;
});

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

  it("logs rather than throws when the queue is down", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(redrawRsvpCard("couple@example.com", brokenQueue)).resolves.toBeUndefined();
    await expect(sendCardJobOrLog(randomUUID(), brokenQueue)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});
