import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cacheLife } from "next/cache";
import { ImageResponse } from "next/og";
import sharp from "sharp";
import { CARD_FONTS, cardElement, ogSize, type PreviewCard } from "@/lib/preview-cards/layout";

/*
 * The build-time link preview cards (the opengraph-image files): the layout in
 * lib/preview-cards/layout.tsx, with the built-in photos and words. Drawn once, at build time: the
 * web server never draws a card (Ruling CJ). Every card that differs from the build's (the couple's
 * photo or focal point, the RSVP card's date or closed replies) is the media worker's
 * (worker/jobs/card.ts), and the page's metadata points og:image at it.
 */

export { ogSize };
// JPEG, not the renderer's PNG: a photo card as PNG is 250–800 KB, and WhatsApp skips
// preview images much over 300 KB.
export const ogContentType = "image/jpeg";

const font = (file: string) => readFile(join(process.cwd(), "src/fonts/og", file));

// Read once when the module loads, so drawing a card does no file I/O and Next can
// prerender it at build time (I/O inside the handler would make it per-request).
const fonts = await Promise.all(
  CARD_FONTS.map(async ({ name, file, weight, style }) => ({ name, data: await font(file), weight, style })),
);

/** A photo in public/ as a data URL. Call it at module level in the card's file, for the same reason. */
export async function loadPhoto(file: string) {
  const image = await readFile(join(process.cwd(), "public", file));
  return `data:image/jpeg;base64,${image.toString("base64")}`;
}

export async function previewCard(card: PreviewCard) {
  return new Response(await renderJpeg(card), { headers: { "Content-Type": ogContentType } });
}

/**
 * Cached so the cards are still prerendered at build time despite the async conversion. Kept for a
 * year (the build table's 1y): the server would only draw one again past that, and every deploy
 * prerenders them afresh.
 */
async function renderJpeg(card: PreviewCard) {
  "use cache";
  cacheLife({ revalidate: 365 * 24 * 60 * 60 });
  const png = await new ImageResponse(cardElement(card), { ...ogSize, fonts }).arrayBuffer();
  return new Uint8Array(await sharp(Buffer.from(png)).jpeg({ quality: 82, mozjpeg: true }).toBuffer());
}
