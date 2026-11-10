// Renders header.html to public/email/header-<hash>.jpg for the confirmation email, and points the
// email at it (src/emails/components/header-image.ts). Needs a Playwright browser once:
// npx playwright install chromium
//
// The site lets caches keep /email files for a week, and Gmail's image proxy keeps them longer, so
// a changed header gets a new address, named after its content, rather than replacing the old file.
// Earlier headers stay, for the emails already sent with them; public/email/header.jpg is kept as a
// copy of the newest, for the emails sent before headers were named this way.
//
// The header is the first thing a guest's phone downloads, often on mobile data, so it is kept
// small: a lossless capture, then a progressive JPEG (it draws in full at low detail first and
// sharpens as it arrives) at the quality of the original capture, with mozjpeg doing the
// shrinking. 1200 x 860, twice the size it is shown at for sharp screens.
import { chromium } from "playwright";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${here}../../public/email`, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
await page.goto(`file://${here}header.html`);
await page.evaluate(() => document.fonts.ready);
const capture = await page.locator(".header").screenshot({ type: "png" });
await browser.close();

const jpeg = await sharp(capture)
  .jpeg({ quality: 82, progressive: true, mozjpeg: true, chromaSubsampling: "4:2:0" })
  .toBuffer();
const name = `header-${createHash("sha256").update(jpeg).digest("hex").slice(0, 10)}.jpg`;
writeFileSync(`${here}../../public/email/${name}`, jpeg);
writeFileSync(`${here}../../public/email/header.jpg`, jpeg);
writeFileSync(
  `${here}../../src/emails/components/header-image.ts`,
  `// Written by design/email-header/render.mjs: the email header's address, named after its content.\nexport const HEADER_IMAGE = "/email/${name}";\n`,
);
console.log(`public/email/${name}: ${Math.round(jpeg.length / 1024)} KB`);
