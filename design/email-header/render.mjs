// Renders header.html to public/email/header.jpg for the confirmation email.
// Needs a Playwright browser once: npx playwright install chromium
//
// The header is the first thing a guest's phone downloads, often on mobile data, so it is kept
// small: a lossless capture, then a progressive JPEG (it draws in full at low detail first and
// sharpens as it arrives) at the quality of the original capture, with mozjpeg doing the
// shrinking. About 80 KB at 1200 x 1040, twice the size it is shown at for sharp screens.
import { chromium } from "playwright";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const output = `${here}../../public/email/header.jpg`;
mkdirSync(`${here}../../public/email`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1080 } });
await page.goto(`file://${here}header.html`);
await page.evaluate(() => document.fonts.ready);
const capture = await page.locator(".header").screenshot({ type: "png" });
await browser.close();

const { size } = await sharp(capture)
  .jpeg({ quality: 82, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" })
  .toFile(output);
console.log(`public/email/header.jpg: ${Math.round(size / 1024)} KB`);
