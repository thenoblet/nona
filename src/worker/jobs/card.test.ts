import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSection } from "@/lib/content/store";
import { contentDefaults } from "@/lib/content/defaults";
import { storageConfig } from "@/lib/env";
import { MEDIA_QUEUES } from "@/lib/jobs/media-queues";
import { readSiteImage, saveSiteImage } from "@/lib/site-images/store";
import { storageClient } from "@/lib/storage/client";
import { resetDb } from "../../../test/db";
import { addSitePhoto, sitePhotoKeys } from "../../../test/site-images";
import { PermanentJobError, type MediaJob } from "../queues";

/*
 * media.card against the local MinIO and test database (docker compose up -d db minio && npm run
 * storage:init): the link preview card the worker draws once the couple change a card's photo.
 */

// Every public PUT, so a test can tell whether a run drew anything.
const puts = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("@/lib/storage/objects", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/storage/objects")>();
  return {
    ...real,
    putPublicObject: async (...args: Parameters<typeof real.putPublicObject>) => {
      puts.keys.push(args[0]);
      return real.putPublicObject(...args);
    },
  };
});

import { CARD_FONTS } from "@/lib/preview-cards/layout";
import { previewCardText } from "@/lib/preview-cards/text";
import { cardHandler, drawCardJpeg, type CardOptions } from "./card";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
/** As in the worker's image: the fonts and the built-in preview photos, from the checkout here. */
const OPTIONS: CardOptions = { fontsFolder: join(projectRoot, "src/fonts/og"), publicFolder: join(projectRoot, "public") };
const MAX_CARD_BYTES = 80 * 1024;

const publicKeys: string[] = [];

beforeEach(async () => {
  await resetDb();
  puts.keys = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  const keys = [...new Set([...publicKeys, ...puts.keys])];
  if (keys.length > 0) {
    await storageClient().send(
      new DeleteObjectsCommand({ Bucket: storageConfig().publicBucket, Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true } }),
    );
  }
});

function cardJob(siteImageId: string): MediaJob {
  return { id: randomUUID(), queue: MEDIA_QUEUES.card, data: { siteImageId }, signal: AbortSignal.timeout(60_000), retryCount: 0 };
}

const draw = (siteImageId: string, options = OPTIONS) => cardHandler(options)(cardJob(siteImageId));

async function readPublic(key: string) {
  const response = await storageClient().send(new GetObjectCommand({ Bucket: storageConfig().publicBucket, Key: key }));
  return {
    bytes: Buffer.from((await response.Body?.transformToByteArray()) ?? []),
    contentType: response.ContentType,
    cacheControl: response.CacheControl,
  };
}

/**
 * A site photo as the photo job leaves it, its sizes in the public bucket: a 2400 × 3600 portrait,
 * blue in its top quarter and red below, with grain so it compresses like a photo.
 */
async function sitePhotoInBucket(): Promise<string> {
  const mediaId = await addSitePhoto({ width: 2400, height: 3600 });
  const keys = sitePhotoKeys(mediaId);
  const width = 1600;
  const height = 2400;
  const grain = Buffer.alloc(width * height * 3);
  for (let index = 0; index < grain.length; index += 1) grain[index] = Math.floor(Math.random() * 60);
  const picture = await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .composite([
      { input: { create: { width, height: height / 4, channels: 3, background: { r: 20, g: 40, b: 230 } } }, left: 0, top: 0 },
      { input: grain, raw: { width, height, channels: 3 }, blend: "add" },
    ])
    .webp({ quality: 80 })
    .toBuffer();
  for (const key of [keys.view, keys.large]) {
    publicKeys.push(key);
    await storageClient().send(
      new PutObjectCommand({ Bucket: storageConfig().publicBucket, Key: key, Body: picture, ContentType: "image/webp" }),
    );
  }
  return mediaId;
}

/** The average colour of a band of the card, as fractions of its height. */
async function bandColour(jpeg: Buffer, topFraction: number, bottomFraction: number): Promise<{ red: number; blue: number }> {
  const top = Math.round(630 * topFraction);
  const { data, info } = await sharp(jpeg)
    .extract({ left: 100, top, width: 1000, height: Math.round(630 * bottomFraction) - top })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let red = 0;
  let blue = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    red += data[index];
    blue += data[index + 2];
  }
  const pixels = data.length / info.channels;
  return { red: red / pixels, blue: blue / pixels };
}

describe("media.card", () => {
  it("draws a saved preview slot's card: a 1200 × 630 JPEG under 80 KB, published under a content hash, its key stored", async () => {
    const mediaId = await sitePhotoInBucket();
    const saved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "A kiss", focal: { x: 0.5, y: 0.3 }, savedBy: "a" });
    const report = await draw(saved.id);

    const row = await readSiteImage(saved.id);
    expect(row?.cardKey).toMatch(new RegExp(`^derived/${mediaId}/[0-9a-f]{16}/card\\.jpg$`));
    const card = await readPublic(row!.cardKey!);
    expect(card.contentType).toBe("image/jpeg");
    expect(card.cacheControl).toBe("public, max-age=31536000, immutable");
    expect(await sharp(card.bytes).metadata()).toMatchObject({ format: "jpeg", width: 1200, height: 630 });
    expect(card.bytes.length).toBeLessThanOrEqual(MAX_CARD_BYTES);
    expect(report).toEqual({ sizeBytes: card.bytes.length, kind: "card/album" });
    // No EXIF in what the worker publishes.
    expect((await sharp(card.bytes).metadata()).exif).toBeUndefined();
  });

  it("cuts the photo at its focal point, as the site crops it", async () => {
    const mediaId = await sitePhotoInBucket();
    const top = await saveSiteImage({ slot: "preview-wishes", mediaId, alt: "Blue", focal: { x: 0.5, y: 0 }, savedBy: "a" });
    await draw(top.id);
    const bottom = await saveSiteImage({ slot: "preview-wishes", mediaId, alt: "Red", focal: { x: 0.5, y: 1 }, savedBy: "a" });
    await draw(bottom.id);
    const topCard = (await readPublic((await readSiteImage(top.id))!.cardKey!)).bytes;
    const bottomCard = (await readPublic((await readSiteImage(bottom.id))!.cardKey!)).bytes;
    // Focused at the top, the card's upper edge shows the blue band through the cocoa wash; at the bottom, only red.
    const topColour = await bandColour(topCard, 0.02, 0.2);
    const bottomColour = await bandColour(bottomCard, 0.02, 0.2);
    expect(topColour.blue).toBeGreaterThan(bottomColour.blue + 10);
    expect(bottomColour.red).toBeGreaterThan(topColour.red + 10);
  });

  it("is idempotent: a retried job finds its card drawn, puts nothing and keeps the key", async () => {
    const mediaId = await sitePhotoInBucket();
    const saved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "A kiss", focal: { x: 0.5, y: 0.3 }, savedBy: "a" });
    await draw(saved.id);
    const key = (await readSiteImage(saved.id))?.cardKey;
    expect(puts.keys).toEqual([key]);
    await draw(saved.id);
    expect(puts.keys).toEqual([key]);
    expect((await readSiteImage(saved.id))?.cardKey).toBe(key);
  });

  it("draws nothing for a row that is no longer its slot's newest: the newer save has a job of its own", async () => {
    const mediaId = await sitePhotoInBucket();
    const older = await saveSiteImage({ slot: "preview-album", mediaId, alt: "One", focal: { x: 0.5, y: 0.3 }, savedBy: "a" });
    await saveSiteImage({ slot: "preview-album", mediaId, alt: "Two", focal: { x: 0.5, y: 0.6 }, savedBy: "a" });
    await draw(older.id);
    expect(puts.keys).toEqual([]);
    expect((await readSiteImage(older.id))?.cardKey).toBeNull();
  });

  it("does nothing for a slot that isn't a link preview, or a row that is gone", async () => {
    const mediaId = await sitePhotoInBucket();
    const hero = await saveSiteImage({ slot: "home-hero", mediaId, alt: "Us", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    await draw(hero.id);
    await draw(randomUUID());
    expect(puts.keys).toEqual([]);
  });

  it("draws a built-in preview photo's card from the photo in the worker's image, at the couple's focal point", async () => {
    const saved = await saveSiteImage({ slot: "preview-wishes", mediaId: null, alt: "Nancy smiling", focal: { x: 0.5, y: 0.1 }, savedBy: "a" });
    await draw(saved.id);
    const key = (await readSiteImage(saved.id))?.cardKey;
    expect(key).toMatch(/^derived\/site-preview-wishes\/[0-9a-f]{16}\/card\.jpg$/);
    const card = await readPublic(key!);
    expect(await sharp(card.bytes).metadata()).toMatchObject({ width: 1200, height: 630 });
    expect(card.bytes.length).toBeLessThanOrEqual(MAX_CARD_BYTES);
  });

  it("names a built-in card by the photo's bytes: a photo swapped under the same file name is drawn again", async () => {
    const swapped = await mkdtemp(join(tmpdir(), "nona-card-public-"));
    try {
      await mkdir(join(swapped, "images/story"), { recursive: true });
      const file = join(swapped, "images/story/nancy-smile.jpg");
      await copyFile(join(projectRoot, "public/images/story/nancy-smile.jpg"), file);
      const saved = await saveSiteImage({ slot: "preview-wishes", mediaId: null, alt: "Nancy", focal: { x: 0.5, y: 0.25 }, savedBy: "a" });
      await draw(saved.id, { ...OPTIONS, publicFolder: swapped });
      const first = (await readSiteImage(saved.id))?.cardKey;
      // The same name, another photo: the shoot's replacement dropped into the image.
      await copyFile(join(projectRoot, "public/images/story/bouquet.jpg"), file);
      await draw(saved.id, { ...OPTIONS, publicFolder: swapped });
      const second = (await readSiteImage(saved.id))?.cardKey;
      expect(second).not.toBe(first);
      expect(puts.keys).toEqual([first, second]);
    } finally {
      await rm(swapped, { recursive: true, force: true });
    }
  });

  it("fails for good, without retrying, when a card can't come under its size limit", async () => {
    const fonts = await Promise.all(
      CARD_FONTS.map(async ({ name, file, weight, style }) => ({ name, data: await readFile(join(OPTIONS.fontsFolder, file)), weight, style })),
    );
    const photo = await readFile(join(projectRoot, "public/images/story/kiss.jpg"));
    const drawing = drawCardJpeg(previewCardText("album", contentDefaults.rsvp), { bytes: photo, focal: { x: 0.5, y: 0.3 } }, fonts, 1_000);
    await expect(drawing).rejects.toBeInstanceOf(PermanentJobError);
    await expect(drawing).rejects.toMatchObject({ reason: "card-too-large" });
  });

  it("draws the RSVP card again under a new key once the site text's reply-by date or replies change", async () => {
    const saved = await saveSiteImage({ slot: "preview-rsvp", mediaId: null, alt: "Bouquet", focal: { x: 0.5, y: 0.2 }, savedBy: "a" });
    await draw(saved.id);
    const open = (await readSiteImage(saved.id))?.cardKey;
    const closing = await saveSection("rsvp", { ...contentDefaults.rsvp, open: false }, "a");
    expect(closing.ok).toBe(true);
    await draw(saved.id);
    const closed = (await readSiteImage(saved.id))?.cardKey;
    expect(closed).not.toBe(open);
    expect(puts.keys).toEqual([open, closed]);
  });

  it("logs ids only: never the alt text, the slot or the card's words", async () => {
    const mediaId = await sitePhotoInBucket();
    const saved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "Ama Owusu's secret kiss", focal: { x: 0.5, y: 0.3 }, savedBy: "noblet@example.com" });
    const lines: string[] = [];
    const record = (...parts: unknown[]) => void lines.push(parts.map(String).join(" "));
    vi.spyOn(console, "log").mockImplementation(record);
    vi.spyOn(console, "warn").mockImplementation(record);
    vi.spyOn(console, "error").mockImplementation(record);
    await draw(saved.id);
    await draw(saved.id);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/Ama|kiss|album|Capture|noblet@|preview/i);
      expect(line.replace(/[0-9a-f-]{36}|[0-9a-f]{16}/g, "")).not.toMatch(/[0-9a-f]{8,}/);
    }
  });

  it("draws with the fonts in the worker's own files, never fetching anything from the network", async () => {
    const mediaId = await sitePhotoInBucket();
    const saved = await saveSiteImage({ slot: "preview-invitation", mediaId, alt: "Us", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      // R2 is the AWS SDK's own HTTP client, not fetch; a data: URL is no network at all.
      if (url.startsWith("data:")) return realFetch(input, init);
      fetched.push(url);
      throw new Error(`The card tried to fetch ${url}`);
    });
    await draw(saved.id);
    expect(fetched).toEqual([]);
    expect((await readSiteImage(saved.id))?.cardKey).toBeTruthy();

    // Without them it fails, naming what is missing, rather than looking elsewhere.
    const empty = await mkdtemp(join(tmpdir(), "nona-card-fonts-"));
    try {
      const again = await saveSiteImage({ slot: "preview-invitation", mediaId, alt: "Us", focal: { x: 0.5, y: 0.9 }, savedBy: "a" });
      await expect(draw(again.id, { ...OPTIONS, fontsFolder: empty })).rejects.toThrow(/pinyon-script-400\.ttf/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
    expect(fetched).toEqual([]);
  });

  it("fails for good when the photo's files are gone from the bucket", async () => {
    const mediaId = await addSitePhoto();
    const saved = await saveSiteImage({ slot: "preview-album", mediaId, alt: "Gone", focal: { x: 0.5, y: 0.5 }, savedBy: "a" });
    await expect(draw(saved.id)).rejects.toBeInstanceOf(PermanentJobError);
  });
});
