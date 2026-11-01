import { readFile } from "node:fs/promises";
import { join } from "node:path";
import satori from "satori";
import sharp from "sharp";
import { previewPhotos } from "@/content/preview-photos";
import { readSection } from "@/lib/content/store";
import { CARD_FONTS, cardElement, ogSize, type CardText } from "@/lib/preview-cards/layout";
import { previewCardText } from "@/lib/preview-cards/text";
import { coverCrop, type Focal } from "@/lib/site-images/focal";
import { previewOf } from "@/lib/site-images/slots";
import { isLiveSiteImage, readSiteImage, setCardKey, type SiteImageRow } from "@/lib/site-images/store";
import { derivedKey } from "@/lib/storage/keys";
import { putPublicObject, readPublicObject } from "@/lib/storage/objects";
import { PermanentJobError, type JobReport, type MediaJob, type MediaJobHandler } from "../queues";
import { contentHashOf } from "./publishing";

/*
 * media.card: a link preview card (WhatsApp, iMessage, Facebook), drawn once the couple change a
 * card's photo, or its focal point, in the admin (Task 19, Ruling CJ). Its data is
 * `{ siteImageId }`: the saved row of one of the four preview slots.
 * 1. Only the slot's live row is drawn: a newer save sent a job of its own (the generation guard).
 * 2. The photo is the couple's (its largest size, from the public bucket) or the slot's built-in
 *    one (a file in the worker's image), cut to 1200 × 630 at the focal point by CSS's own rule
 *    (coverCrop), as the site crops it.
 * 3. satori lays out lib/preview-cards/layout.tsx, the build-time cards' own tree, with the fonts
 *    from the worker's image: nothing is fetched, and a glyph the fonts lack is left out rather than
 *    looked up online. sharp renders its SVG and writes a JPEG of at most 80 KB, about 50 KB, with no
 *    EXIF.
 * 4. The JPEG goes to the public bucket under a content hash of everything it was drawn from (the
 *    photo, the focal point, the words, these settings), so a retried job finds the same key, and
 *    its key is stored on the row (card_key). A row whose card is already that key does nothing.
 * The RSVP card's words follow the site text (its reply-by date, or that replies closed), so a
 * change there sends this job again (lib/site-images/cards.ts), and the card gets a new key.
 * Logs carry ids, sizes and timings only: never the alt text, the slot or the card's words.
 */

/** Part of every card's content hash: raise it whenever the layout, the size or the JPEG settings change. */
const CARD_SETTINGS_VERSION = 1;
/** WhatsApp skips preview images much over 300 KB; the brief keeps a card under 80 KB. */
export const MAX_CARD_BYTES = 80 * 1024;
/** The size a card aims for: the first quality, from the top, that comes under it. */
const TARGET_CARD_BYTES = 56 * 1024;
const QUALITIES = [82, 76, 70, 64, 58, 50, 42, 34];
/** The photo is cut at this quality before satori embeds it; the card's own JPEG is what counts. */
const EMBEDDED_PHOTO_QUALITY = 88;
/** The most pixels a photo to draw from may have: a site photo's largest size is 2400 px wide. */
const MAX_PHOTO_PIXELS = 40_000_000;

export type CardOptions = {
  /** The card's TTF fonts (src/fonts/og in the checkout, card-assets/fonts in the image). */
  fontsFolder: string;
  /** Where the built-in preview photos' paths start (public/ in the checkout, card-assets/public in the image). */
  publicFolder: string;
};

type Font = { name: string; data: Buffer; weight: 400 | 500; style: "normal" | "italic" };

const fontsByFolder = new Map<string, Promise<Font[]>>();

/** The fonts, read once per folder from the worker's own files; a failed read is tried again by the next job. */
function loadFonts(folder: string): Promise<Font[]> {
  let loading = fontsByFolder.get(folder);
  if (!loading) {
    loading = Promise.allSettled(CARD_FONTS.map(({ file }) => readFile(join(folder, file)))).then((reads) =>
      reads.map((read, index) => {
        const { name, file, weight, style } = CARD_FONTS[index];
        // The first missing font in the list's order, named, whichever read failed first.
        if (read.status === "rejected") throw new Error(`The card's font ${file} can't be read from ${folder}`, { cause: read.reason });
        return { name, data: read.value, weight, style };
      }),
    );
    loading.catch(() => fontsByFolder.delete(folder));
    fontsByFolder.set(folder, loading);
  }
  return loading;
}

/** The photo a row draws from: where it comes from (for the hash and the key) and how to read it. */
type PhotoSource = { identity: string; keyOwner: string; read: () => Promise<Buffer> };

function photoSourceOf(row: SiteImageRow, card: keyof typeof previewPhotos, options: CardOptions, signal: AbortSignal): PhotoSource {
  if (!row.mediaId) {
    const { file } = previewPhotos[card];
    return { identity: `builtin:${file}`, keyOwner: `site-${row.slot}`, read: () => readFile(join(options.publicFolder, file)) };
  }
  const key = row.photo?.derived.large ?? row.photo?.derived.view;
  if (row.photo?.status !== "ready" || !key) {
    throw new PermanentJobError("photo-not-ready", `site-image=${row.id}: its photo has no sizes to draw from`);
  }
  return {
    identity: `media:${key}`,
    keyOwner: row.mediaId,
    read: async () => {
      const bytes = await readPublicObject(key, { signal });
      if (!bytes) throw new PermanentJobError("photo-missing", `site-image=${row.id}: its photo's file is gone from the bucket`);
      return bytes;
    },
  };
}

/** The photo, upright, cut to the card's size at the focal point, as a JPEG data URL for satori. */
async function croppedPhoto(bytes: Buffer, focal: Focal): Promise<string> {
  const opened = () => sharp(bytes, { limitInputPixels: MAX_PHOTO_PIXELS, failOn: "error" });
  const { autoOrient } = await opened().metadata();
  const crop = coverCrop(autoOrient, ogSize, focal);
  const jpeg = await opened()
    .autoOrient()
    .resize(crop.width, crop.height, { fit: "fill" })
    .extract({ left: crop.left, top: crop.top, width: ogSize.width, height: ogSize.height })
    .jpeg({ quality: EMBEDDED_PHOTO_QUALITY })
    .toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}

/**
 * Draws a card: satori's SVG of the layout, rendered by sharp once, then written as a JPEG at the
 * highest quality that comes under about 50 KB (or, failing that, 80 KB). Exported for its test.
 */
export async function drawCardJpeg(
  text: CardText,
  photo: { bytes: Buffer; focal: Focal },
  fonts: Font[],
): Promise<{ jpeg: Buffer; quality: number }> {
  const svg = await satori(cardElement({ ...text, photo: await croppedPhoto(photo.bytes, photo.focal), position: "center" }), {
    width: ogSize.width,
    height: ogSize.height,
    fonts,
  });
  const pixels = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels };
  let fallback: { jpeg: Buffer; quality: number } | null = null;
  for (const quality of QUALITIES) {
    const jpeg = await sharp(pixels.data, { raw }).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (jpeg.length <= TARGET_CARD_BYTES) return { jpeg, quality };
    if (!fallback && jpeg.length <= MAX_CARD_BYTES) fallback = { jpeg, quality };
  }
  if (fallback) return fallback;
  throw new Error(`The card is over ${MAX_CARD_BYTES} bytes even at quality ${QUALITIES.at(-1)}`);
}

/** media.card's work for one job. */
export async function drawCard(job: MediaJob, options: CardOptions): Promise<JobReport | void> {
  const siteImageId = typeof job.data.siteImageId === "string" ? job.data.siteImageId : "";
  const subject = `[worker] ${job.queue} site-image=${siteImageId || "none"}`;
  const row = await readSiteImage(siteImageId);
  const card = row ? previewOf(row.slot) : null;
  if (!row || !card) {
    console.log(`${subject}: nothing to draw, the row is gone or isn't a link preview's`);
    return;
  }
  if (!(await isLiveSiteImage(row.id))) {
    console.log(`${subject}: nothing to draw, a newer save of its slot draws its own`);
    return;
  }

  const { value: rsvp } = await readSection("rsvp");
  const text = previewCardText(card, rsvp);
  const source = photoSourceOf(row, card, options, job.signal);
  const inputs = JSON.stringify({ focal: [row.focal.x, row.focal.y], text });
  const contentHash = contentHashOf(source.identity, `card-settings-${CARD_SETTINGS_VERSION}\n${inputs}`);
  const key = derivedKey(source.keyOwner, contentHash, "card", "jpg");
  if (row.cardKey === key) {
    console.log(`${subject}: its card is drawn already`);
    return;
  }

  const [bytes, fonts] = await Promise.all([source.read(), loadFonts(options.fontsFolder)]);
  const startedAt = performance.now();
  const { jpeg, quality } = await drawCardJpeg(text, { bytes, focal: row.focal }, fonts);
  const drawMilliseconds = Math.round(performance.now() - startedAt);
  await putPublicObject(key, jpeg, "image/jpeg", { signal: job.signal });
  if (!(await setCardKey(row.id, key))) {
    console.log(`${subject}: drawn, but the row went meanwhile`);
    return;
  }
  console.log(`${subject}: drawn in ${drawMilliseconds} ms, ${jpeg.length} bytes at quality ${quality}`);
  return { sizeBytes: jpeg.length, kind: `card/${card}` };
}

/** media.card's handler, with where its fonts and built-in photos are. */
export function cardHandler(options: CardOptions): MediaJobHandler {
  return (job) => drawCard(job, options);
}
