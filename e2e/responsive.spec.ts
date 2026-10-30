import { expect, test, type Locator, type Page } from "@playwright/test";

// No page may scroll sideways on any phone, tablet or laptop (Noblet, 30 Oct). The admin's data
// pages need a Cloudflare Access sign-in, which this production build can't fake, so only the
// admin's refusal is checked here; the signed-in pages are checked against the dev server.
const widths = [320, 360, 390, 768, 1024, 1440];

// Each page's own content, checked first, so a blank or error page can't pass by being narrow.
const heading = (name: RegExp) => (page: Page) => page.getByRole("heading", { level: 1, name });
const pages: { path: string; marker: (page: Page) => Locator }[] = [
  { path: "/", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=before", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=day", marker: heading(/Noblet & Nancy/) },
  { path: "/home?mode=after", marker: heading(/Thank you/) },
  { path: "/rsvp", marker: heading(/Kindly respond/) },
  { path: "/album", marker: heading(/Capture it with us/) },
  { path: "/today", marker: heading(/the day/) },
  { path: "/wishes", marker: heading(/Leave us a wish/) },
  { path: "/admin/rsvps", marker: (page) => page.getByText("This page is for the couple.") },
  { path: "/admin/content/celebrations", marker: (page) => page.getByText("This page is for the couple.") },
];

for (const { path, marker } of pages) {
  test.describe(path, () => {
    for (const width of widths) {
      test(`does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path, { waitUntil: "networkidle" });
        await expect(marker(page)).toBeVisible();
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
