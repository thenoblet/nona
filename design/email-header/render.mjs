// Renders header.html to public/email/header.jpg for the confirmation email.
// Needs a Playwright browser once: npx playwright install chromium
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${here}../../public/email`, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 1080 } });
await page.goto(`file://${here}header.html`);
await page.evaluate(() => document.fonts.ready);
await page.locator(".header").screenshot({ path: `${here}../../public/email/header.jpg`, type: "jpeg", quality: 84 });
await browser.close();
