import { expect, test } from "@playwright/test";

// No page may scroll sideways on any phone, tablet or laptop (Noblet, 30 Oct). The admin's data
// pages need a Cloudflare Access sign-in, which this production build can't fake, so only the
// admin's refusal is checked here; the signed-in pages are checked against the dev server.
const widths = [320, 360, 390, 768, 1024, 1440];
const pages = [
  "/",
  "/home?mode=before",
  "/home?mode=day",
  "/home?mode=after",
  "/rsvp",
  "/album",
  "/today",
  "/wishes",
  "/admin/rsvps",
];

for (const path of pages) {
  test.describe(path, () => {
    for (const width of widths) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const { scrollWidth, innerWidth } = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        expect(scrollWidth, `${path} is ${scrollWidth}px wide in a ${innerWidth}px window`).toBeLessThanOrEqual(innerWidth);
      });
    }
  });
}
